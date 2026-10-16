import type { Feature } from '../../extension/background/types.ts';
import { oneLine } from '../../extension/background/util.ts';

type Level = 'log' | 'info' | 'warning' | 'error' | 'debug';

interface Entry {
  at: number;
  level: Level;
  source: string;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stack?: string[];
  frame?: string;
}

/** Per-tab ring buffer size (BRD 2.2.13: bounded, oldest dropped first). */
const MAX_ENTRIES = 1000;

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  className?: string;
  preview?: { properties?: Array<{ name: string; value?: string; type: string }>; overflow?: boolean; subtype?: string };
}

export function formatRemote(obj: RemoteObject): string {
  if (obj.type === 'string') return String(obj.value);
  if (obj.unserializableValue) return obj.unserializableValue;
  if (obj.type === 'undefined') return 'undefined';
  if (obj.type === 'number' || obj.type === 'boolean' || obj.type === 'bigint') return String(obj.value ?? obj.description);
  if (obj.subtype === 'null') return 'null';
  if (obj.type === 'function') return (obj.description ?? 'function').split('\n')[0]!;
  if (obj.preview?.properties) {
    const props = obj.preview.properties.map((p) => (obj.subtype === 'array' ? p.value ?? '' : `${p.name}: ${p.type === 'string' ? JSON.stringify(p.value) : p.value}`));
    const body = props.join(', ') + (obj.preview.overflow ? ', …' : '');
    return obj.subtype === 'array' ? `[${body}]` : `${obj.className && obj.className !== 'Object' ? `${obj.className} ` : ''}{${body}}`;
  }
  return obj.description ?? obj.className ?? obj.type;
}

/** Applies console format specifiers (%s %d %i %f %o %O %c) like DevTools. */
export function formatConsoleArgs(args: RemoteObject[]): string {
  if (!args.length) return '';
  const [first, ...rest] = args;
  if (first!.type !== 'string' || !/%[sdifoOc]/.test(String(first!.value))) return args.map(formatRemote).join(' ');
  let i = 0;
  const head = String(first!.value).replace(/%([sdifoOc])/g, (_m, spec: string) => {
    const arg = rest[i++];
    if (!arg) return '';
    if (spec === 'c') return '';
    if (spec === 'd' || spec === 'i') return String(Math.trunc(Number(arg.value ?? arg.description)));
    if (spec === 'f') return String(Number(arg.value ?? arg.description));
    return formatRemote(arg);
  });
  return [head, ...rest.slice(i).map(formatRemote)].join(' ');
}

function stackOf(trace?: { callFrames: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }> }): string[] | undefined {
  if (!trace?.callFrames?.length) return undefined;
  return trace.callFrames.slice(0, 6).map((f) => `at ${f.functionName || '(anonymous)'} (${f.url || '<anonymous>'}:${f.lineNumber + 1}:${f.columnNumber + 1})`);
}

const buffers = new Map<number, Entry[]>();

function push(tabId: number, entry: Entry): void {
  let list = buffers.get(tabId);
  if (!list) buffers.set(tabId, (list = []));
  list.push(entry);
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
}

const LEVELS: Record<string, Level> = { log: 'log', info: 'info', warning: 'warning', warn: 'warning', error: 'error', debug: 'debug', verbose: 'debug', assert: 'error', trace: 'log', dir: 'log', dirxml: 'log', table: 'log', count: 'log', timeEnd: 'log', profile: 'log', profileEnd: 'log', startGroup: 'log', startGroupCollapsed: 'log' };

export const consoleFeature: Feature = {
  name: 'console',
  setup(core) {
    core.cdp.onAttach(async (tabId, sessionId) => {
      await core.cdp.send(tabId, 'Log.enable', {}, sessionId).catch(() => {});
    });
    core.cdp.on((tabId, sessionId, method, params) => {
      const frame = sessionId ? core.cdp.child(tabId, sessionId)?.url : undefined;
      if (method === 'Runtime.consoleAPICalled') {
        if (params.type === 'clear') {
          buffers.delete(tabId);
          return;
        }
        if (params.type === 'endGroup') return;
        const top = params.stackTrace?.callFrames?.[0];
        push(tabId, {
          at: params.timestamp ?? Date.now(),
          level: LEVELS[params.type] ?? 'log',
          source: params.type === 'assert' ? 'assert' : 'console',
          text: (params.type === 'assert' ? 'Assertion failed: ' : '') + formatConsoleArgs(params.args ?? []),
          url: top?.url,
          line: top ? top.lineNumber + 1 : undefined,
          column: top ? top.columnNumber + 1 : undefined,
          stack: stackOf(params.stackTrace),
          frame,
        });
      } else if (method === 'Runtime.exceptionThrown') {
        const d = params.exceptionDetails;
        push(tabId, {
          at: params.timestamp ?? Date.now(),
          level: 'error',
          source: 'exception',
          text: d.exception?.description?.split('\n')[0] ?? d.text,
          url: d.url,
          line: d.lineNumber !== undefined ? d.lineNumber + 1 : undefined,
          column: d.columnNumber !== undefined ? d.columnNumber + 1 : undefined,
          stack: stackOf(d.stackTrace),
          frame,
        });
      } else if (method === 'Log.entryAdded') {
        const e = params.entry;
        push(tabId, { at: e.timestamp ?? Date.now(), level: LEVELS[e.level] ?? 'log', source: e.source, text: e.text, url: e.url, line: e.lineNumber !== undefined ? e.lineNumber + 1 : undefined, stack: stackOf(e.stackTrace), frame });
      }
    });
    chrome.tabs.onRemoved.addListener((tabId) => buffers.delete(tabId));
    core.addActionObserver((tabId, since) => {
      const errors = (buffers.get(tabId) ?? []).filter((e) => e.at >= since && e.level === 'error');
      return errors.length ? [`${errors.length} new console error${errors.length > 1 ? 's' : ''}: ${errors.slice(0, 3).map((e) => oneLine(e.text, 140)).join(' | ')}`] : [];
    });
  },
  handlers: {
    async console_logs(args: { levels?: Level[]; pattern?: string; since?: number; limit?: number; stack?: boolean; clear?: boolean }, { core, tabId }) {
      await core.cdp.ensure(tabId);
      let list = buffers.get(tabId) ?? [];
      const total = list.length;
      if (args.levels?.length) list = list.filter((e) => args.levels!.includes(e.level));
      if (args.since) list = list.filter((e) => e.at >= args.since!);
      if (args.pattern) {
        const re = new RegExp(args.pattern, 'i');
        list = list.filter((e) => re.test(e.text) || (e.url && re.test(e.url)));
      }
      const limit = args.limit ?? 100;
      const shown = list.slice(-limit);
      if (args.clear) buffers.delete(tabId);
      if (!shown.length) return `No console messages${total ? ` match (buffer has ${total})` : ''}.`;
      const lines = shown.map((e) => {
        const time = new Date(e.at).toISOString().slice(11, 23);
        const where = e.url ? ` (${e.url}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ''}` : ''})` : '';
        const head = `[${time}] ${e.level.toUpperCase().padEnd(7)} ${e.source !== 'console' ? `[${e.source}] ` : ''}${e.text.length > 2000 ? `${e.text.slice(0, 2000)}…` : e.text}${where}${e.frame ? ` [iframe ${e.frame}]` : ''}`;
        const stack = (args.stack ?? e.level === 'error') && e.stack ? `\n    ${e.stack.join('\n    ')}` : '';
        return head + stack;
      });
      return `${shown.length} of ${list.length} matching messages (buffer ${total}${args.clear ? ', now cleared' : ''}):\n${lines.join('\n')}`;
    },
  },
};

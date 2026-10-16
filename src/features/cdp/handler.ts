import type { Core } from '../../extension/background/core.ts';
import { EXTENSION_BLOCKED_DOMAINS } from '../../extension/background/cdp.ts';
import type { Feature } from '../../extension/background/types.ts';
import { ToolError, errorMessage, truncate } from '../../extension/background/util.ts';

/** Domains other tools depend on: disabling them through raw commands is ignored (BRD 2.2.20). */
const MANAGED = new Set(['Page', 'Runtime', 'Network', 'Log', 'DOM', 'CSS', 'Audits', 'Fetch', 'Performance', 'Accessibility', 'Target', 'WebMCP', 'Inspector']);

interface Subscription {
  patterns: Set<string>;
  events: Array<{ at: number; method: string; sessionId?: string; params: unknown }>;
}

const MAX_EVENTS = 500;
const subscriptions = new Map<string, Subscription>();
const subKey = (sessionId: string, tabId: number) => `${sessionId}|${tabId}`;

function matches(patterns: Set<string>, method: string): boolean {
  if (patterns.has(method)) return true;
  const domain = method.split('.')[0];
  return patterns.has(`${domain}.*`) || patterns.has('*');
}

async function resolveSession(core: Core, tabId: number, frame?: string, sessionId?: string): Promise<{ sessionId?: string; targetId?: string }> {
  if (sessionId) {
    const child = core.cdp.child(tabId, sessionId);
    if (!child) throw new ToolError(`Unknown session ${sessionId} (see page_info for child sessions).`);
    return { sessionId, targetId: child.targetId };
  }
  if (!frame) return {};
  const owner = core.refs.get(tabId, frame);
  const { node } = await core.cdp.send(tabId, 'DOM.describeNode', { backendNodeId: owner.backendNodeId }, owner.sessionId);
  const child = core.cdp.children(tabId).find((c) => c.targetId === node.frameId);
  if (!child) throw new ToolError(`[${owner.ref}] is not an out-of-process iframe; same-process frames share the tab session.`);
  return { sessionId: child.sessionId, targetId: child.targetId };
}

function format(result: unknown): string {
  const json = JSON.stringify(result, null, 2) ?? 'undefined';
  return truncate(json, 60_000, 'narrow the command or use cdp_send with smaller params');
}

export const cdpFeature: Feature = {
  name: 'cdp',
  setup(core) {
    core.cdp.on((tabId, sessionId, method, params) => {
      for (const [key, sub] of subscriptions) {
        if (!key.endsWith(`|${tabId}`) || !matches(sub.patterns, method)) continue;
        sub.events.push({ at: Date.now(), method, sessionId, params });
        if (sub.events.length > MAX_EVENTS) sub.events.shift();
      }
    });
    core.onSessionEnd((session) => {
      for (const key of subscriptions.keys()) if (key.startsWith(`${session.id}|`)) subscriptions.delete(key);
    });
  },
  handlers: {
    async cdp_send(args: { method: string; params?: Record<string, unknown>; frame?: string; sessionId?: string; via?: 'auto' | 'extension' | 'full' }, { core, tabId, session }) {
      const [domain] = args.method.split('.');
      if (!domain || !args.method.includes('.')) throw new ToolError('method must look like "Domain.command".');
      await core.cdp.ensure(tabId);
      if (args.method.endsWith('.disable') && MANAGED.has(domain)) {
        return `Ignored ${args.method}: other Neo WebMCP tools rely on the ${domain} domain, so it stays enabled.`;
      }
      const target = await resolveSession(core, tabId, args.frame, args.sessionId);
      const via = args.via ?? 'auto';
      const viaFull = async () => {
        const targetId = target.targetId ?? (await core.targetIdFor(tabId));
        const result = await session.service('fdc.send', { targetId, method: args.method, params: args.params ?? {} });
        return `${args.method} (via full DevTools channel):\n${format(result)}`;
      };
      if (via === 'full' || (via === 'auto' && EXTENSION_BLOCKED_DOMAINS.has(domain))) {
        try {
          return await viaFull();
        } catch (error) {
          throw new ToolError(`${args.method} needs the full DevTools channel: ${errorMessage(error)}`);
        }
      }
      try {
        const result = await core.cdp.send(tabId, args.method, args.params ?? {}, target.sessionId);
        let note = '';
        if (args.method === 'Debugger.enable') {
          // A `debugger;` statement would otherwise freeze the user's tab.
          await core.cdp.send(tabId, 'Debugger.setSkipAllPauses', { skip: true }, target.sessionId).catch(() => {});
          note = '\n(Pausing on breakpoints/debugger statements is skipped so the tab cannot freeze; send Debugger.setSkipAllPauses {skip:false} if you really want pauses.)';
        }
        return `${args.method}:\n${format(result)}${note}`;
      } catch (error) {
        const msg = errorMessage(error);
        if (via === 'auto' && /wasn't found|not allowed|Not allowed/i.test(msg)) {
          try {
            return await viaFull();
          } catch (fullError) {
            throw new ToolError(`${msg}\nThe extension cannot use this command and the full DevTools channel failed: ${errorMessage(fullError)}`);
          }
        }
        throw new ToolError(msg);
      }
    },

    async cdp_events(args: { action: 'subscribe' | 'read' | 'unsubscribe'; events?: string[]; limit?: number; clear?: boolean }, { core, tabId, session }) {
      await core.cdp.ensure(tabId);
      const key = subKey(session.id, tabId);
      if (args.action === 'subscribe') {
        if (!args.events?.length) throw new ToolError('List the events to subscribe to.');
        const sub = subscriptions.get(key) ?? { patterns: new Set<string>(), events: [] };
        for (const e of args.events) sub.patterns.add(e);
        subscriptions.set(key, sub);
        return `Subscribed to ${[...sub.patterns].join(', ')} on tab ${tabId}. Make sure the domains are enabled (cdp_send "<Domain>.enable"); read with action "read".`;
      }
      if (args.action === 'unsubscribe') {
        if (args.events?.length) {
          const sub = subscriptions.get(key);
          for (const e of args.events) sub?.patterns.delete(e);
          if (sub && !sub.patterns.size) subscriptions.delete(key);
        } else subscriptions.delete(key);
        return 'Unsubscribed.';
      }
      const sub = subscriptions.get(key);
      if (!sub) throw new ToolError('No subscription on this tab; subscribe first.');
      const shown = sub.events.slice(-(args.limit ?? 50));
      if (args.clear !== false) sub.events = [];
      if (!shown.length) return 'No events captured yet.';
      return shown
        .map((e) => `[${new Date(e.at).toISOString().slice(11, 23)}] ${e.method}${e.sessionId ? ` (session ${e.sessionId.slice(0, 8)})` : ''} ${truncate(JSON.stringify(e.params), 2000)}`)
        .join('\n');
    },
  },
};

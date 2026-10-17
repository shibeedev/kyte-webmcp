import type { ToolResult } from '../../shared/protocol.ts';
import { specByName } from '../../features/specs.ts';
import type { Core } from './core.ts';
import { resolveTargetTab, type Session } from './sessions.ts';
import type { HandlerOutput, ToolHandler } from './types.ts';
import { ToolError, errorMessage } from './util.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Agent-facing texts stay in English whatever the UI language. */
const PAUSED_TEXT = 'The user paused browser control for this session in the Kyte WebMCP extension. Ask the user to click Resume in the Kyte WebMCP side panel (or on the page) before continuing.';
const STOPPED_TEXT = 'The user pressed Stop in the Kyte WebMCP extension; the command was cancelled and the session is paused. Ask the user before continuing.';

function normalize(out: HandlerOutput): ToolResult {
  if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
  if (Array.isArray(out)) return { content: out };
  return out;
}

function summarize(result: ToolResult): string {
  const first = result.content.find((c) => c.type === 'text');
  const images = result.content.filter((c) => c.type === 'image').length;
  const text = first && first.type === 'text' ? first.text.split('\n')[0]! : '';
  return [text, images ? `${images} image${images > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
}

/** Routes tool calls to feature handlers with target-tab resolution, timeouts, per-tab locks and activity logging. */
export class Dispatcher {
  readonly #core: Core;
  readonly #handlers = new Map<string, ToolHandler>();
  readonly #locks = new Map<number, Promise<void>>();

  constructor(core: Core) {
    this.#core = core;
  }

  register(handlers: Record<string, ToolHandler>): void {
    for (const [name, handler] of Object.entries(handlers)) this.#handlers.set(name, handler);
  }

  has(tool: string): boolean {
    return this.#handlers.has(tool);
  }

  async #lock(tabId: number, signal: AbortSignal): Promise<() => void> {
    const previous = this.#locks.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const chained = previous.then(() => current);
    this.#locks.set(tabId, chained);
    const done = () => {
      release();
      if (this.#locks.get(tabId) === chained) this.#locks.delete(tabId);
    };
    try {
      await Promise.race([previous, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new ToolError('Cancelled')), { once: true }))]);
    } catch (error) {
      done(); // never leave later callers waiting on an abandoned slot
      throw error;
    }
    return done;
  }

  async handle(session: Session, id: number, tool: string, args: Record<string, unknown>): Promise<void> {
    const core = this.#core;
    const spec = specByName.get(tool);
    const handler = this.#handlers.get(tool);
    if (!spec || !handler) {
      session.send({ t: 'result', id, result: { content: [{ type: 'text', text: `The extension does not implement "${tool}". Update the Kyte WebMCP extension to match the bridge.` }], isError: true } });
      return;
    }
    if (session.paused) {
      session.send({ t: 'result', id, result: { content: [{ type: 'text', text: PAUSED_TEXT }], isError: true } });
      return;
    }
    const controller = new AbortController();
    session.inflight.set(id, controller);
    session.callCount++;
    core.sessionsChanged();
    let tabId: number | null = null;
    let release: (() => void) | undefined;
    let result: ToolResult;
    const entry = core.activity.start(session.id, session.name, tool, args, null);
    try {
      if (!spec.noTab) {
        tabId = await resolveTargetTab(session, args.tabId);
        entry.tabId = tabId;
        session.touchedTabs.add(tabId);
      }
      if (spec.exclusive && tabId !== null) release = await this.#lock(tabId, controller.signal);
      if (tabId !== null) void core.overlay.activity(tabId, session);
      const requested = typeof args.timeoutMs === 'number' ? args.timeoutMs + 5000 : 0;
      const budget = Math.min(Math.max(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, requested), spec.maxTimeoutMs ?? spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const out = await Promise.race([
        handler(args, { session, tabId: tabId ?? -1, signal: controller.signal, spec, core }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new ToolError(`${tool} timed out after ${budget} ms.`));
            controller.abort(); // stop the handler's remaining work
          }, budget);
        }),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () => {
            if (!timedOut) reject(new ToolError(session.paused ? STOPPED_TEXT : 'Cancelled'));
          }, { once: true }),
        ),
      ]).finally(() => clearTimeout(timer));
      result = normalize(out);
    } catch (error) {
      let message = errorMessage(error);
      // Several things reject on abort (the handler's own waits, the abort watcher); report why it was aborted.
      if (controller.signal.aborted && session.paused) message = STOPPED_TEXT;
      result = { content: [{ type: 'text', text: error instanceof ToolError || message === STOPPED_TEXT ? message : `${tool} failed: ${message}` }], isError: true };
    } finally {
      release?.();
      session.inflight.delete(id);
      if (tabId !== null) void core.page.releaseTemp(tabId);
    }
    core.activity.finish(entry, !result.isError, summarize(result));
    session.send({ t: 'result', id, result });
    core.sessionsChanged(); // busy → idle in the side panel
    if (tabId !== null) void core.overlay.activity(tabId, session);
  }
}

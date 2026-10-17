import { ToolError, errorMessage } from './util.ts';

export interface ChildSession {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  parentSessionId?: string;
}

export type CdpEventListener = (tabId: number, sessionId: string | undefined, method: string, params: any) => void;
export type AttachHook = (tabId: number, sessionId: string | undefined, type: string) => Promise<void>;

interface TabState {
  ready: Promise<void>;
  children: Map<string, ChildSession>;
}

/** Keeps response bodies around long enough for network_request/HAR without unbounded memory. */
const NETWORK_BUFFERS = { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024 };

/** Domains Chrome refuses to expose to extensions (verified on Chrome 155); they go through the full DevTools channel. */
export const EXTENSION_BLOCKED_DOMAINS = new Set([
  'Animation', 'Autofill', 'BackgroundService', 'Browser', 'Cast', 'DOMStorage', 'DeviceAccess', 'DeviceOrientation', 'EventBreakpoints',
  'Extensions', 'FedCm', 'FileSystem', 'FindInPage', 'HeadlessExperimental', 'HeapProfiler', 'IndexedDB', 'LayerTree', 'Media', 'Memory',
  'PWA', 'PerformanceTimeline', 'Preload', 'Profiler', 'Schema', 'Security', 'ServiceWorker', 'SystemInfo', 'Tethering', 'CrashReportContext',
]);

/**
 * chrome.debugger wrapper: attaches on demand, auto-attaches to
 * out-of-process iframes and workers (flattened sessions) and fans events
 * out to features.
 */
export class Cdp {
  readonly #tabs = new Map<number, TabState>();
  readonly #listeners = new Set<CdpEventListener>();
  readonly #attachHooks: AttachHook[] = [];
  readonly #detachListeners = new Set<(tabId: number, reason: string) => void>();

  constructor() {
    chrome.debugger.onEvent.addListener((source, method, params) => this.#onEvent(source, method, params));
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId === undefined) return;
      this.#tabs.delete(source.tabId);
      for (const l of this.#detachListeners) l(source.tabId, reason);
    });
  }

  isAttached(tabId: number): boolean {
    return this.#tabs.has(tabId);
  }

  attachedTabs(): number[] {
    return [...this.#tabs.keys()];
  }

  /** Runs for the main session (sessionId undefined) and each auto-attached child session. */
  onAttach(hook: AttachHook): void {
    this.#attachHooks.push(hook);
  }

  onDetach(listener: (tabId: number, reason: string) => void): void {
    this.#detachListeners.add(listener);
  }

  on(listener: CdpEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  children(tabId: number): ChildSession[] {
    return [...(this.#tabs.get(tabId)?.children.values() ?? [])];
  }

  child(tabId: number, sessionId: string): ChildSession | undefined {
    return this.#tabs.get(tabId)?.children.get(sessionId);
  }

  async ensure(tabId: number): Promise<void> {
    let state = this.#tabs.get(tabId);
    if (!state) {
      state = { ready: this.#attach(tabId), children: new Map() };
      this.#tabs.set(tabId, state);
      state.ready.catch(() => {
        if (this.#tabs.get(tabId) === state) this.#tabs.delete(tabId);
      });
    }
    await state.ready;
  }

  async #attach(tabId: number): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (error) {
      const msg = errorMessage(error);
      // After a service-worker restart we may still hold the session.
      if (!/already attached/i.test(msg)) {
        if (/cannot (access|attach)|chrome:\/\/|chrome-extension:\/\/|webstore/i.test(msg)) {
          throw new ToolError(`Chrome does not allow extensions to control this tab (${msg}). Browser pages like chrome:// and the Web Store are protected; use another tab.`);
        }
        throw new ToolError(`Could not attach the debugger to tab ${tabId}: ${msg}`);
      }
    }
    await this.send(tabId, 'Page.enable');
    await this.send(tabId, 'Runtime.enable');
    await this.send(tabId, 'Network.enable', NETWORK_BUFFERS);
    await this.send(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await this.#runHooks(tabId, undefined, 'page');
  }

  async #runHooks(tabId: number, sessionId: string | undefined, type: string): Promise<void> {
    for (const hook of this.#attachHooks) {
      try {
        await hook(tabId, sessionId, type);
      } catch (error) {
        console.warn('[kyte-webmcp] attach hook failed', errorMessage(error));
      }
    }
  }

  async send<T = any>(tabId: number, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const target: chrome.debugger.DebuggerSession = sessionId ? { tabId, sessionId } : { tabId };
    try {
      return (await chrome.debugger.sendCommand(target, method, params)) as T;
    } catch (error) {
      const msg = errorMessage(error);
      if (/not attached|Detached while handling/i.test(msg)) this.#tabs.delete(tabId);
      throw new Error(`${method}: ${msg}`);
    }
  }

  async detach(tabId: number): Promise<void> {
    this.#tabs.delete(tabId);
    // Always ask Chrome: our bookkeeping may have dropped the tab after a failed command while Chrome still holds the session.
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  #onEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const state = this.#tabs.get(tabId);
    if (method === 'Target.attachedToTarget' && state) {
      const info = params.targetInfo as { targetId: string; type: string; url: string };
      const child: ChildSession = { sessionId: params.sessionId, targetId: info.targetId, type: info.type, url: info.url, parentSessionId: source.sessionId };
      state.children.set(child.sessionId, child);
      void (async () => {
        try {
          await this.send(tabId, 'Runtime.enable', {}, child.sessionId);
          await this.send(tabId, 'Network.enable', NETWORK_BUFFERS, child.sessionId).catch(() => {});
          if (info.type === 'iframe') {
            await this.send(tabId, 'Page.enable', {}, child.sessionId);
            await this.send(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child.sessionId);
          }
          await this.#runHooks(tabId, child.sessionId, info.type);
        } catch {
          /* child went away */
        }
      })();
    } else if (method === 'Target.detachedFromTarget' && state) {
      state.children.delete(params.sessionId);
    } else if (method === 'Target.targetInfoChanged' && state) {
      const info = params.targetInfo as { targetId: string; url: string };
      for (const c of state.children.values()) if (c.targetId === info.targetId) c.url = info.url;
    }
    for (const l of this.#listeners) {
      try {
        l(tabId, source.sessionId, method, params);
      } catch (error) {
        console.warn('[kyte-webmcp] CDP listener failed', method, errorMessage(error));
      }
    }
  }
}

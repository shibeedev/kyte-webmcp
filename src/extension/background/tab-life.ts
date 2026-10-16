import type { Cdp } from './cdp.ts';
import { ToolError, sleep } from './util.ts';

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt?: string;
  url?: string;
}

export interface DocumentResponse {
  url: string;
  status: number;
  statusText: string;
  loaderId?: string;
  protocol?: string;
  remoteAddress?: string;
  security?: { protocol: string; cipher: string; subjectName: string; issuer: string; validTo: number };
  at: number;
}

interface Life {
  mainFrameId?: string;
  /** Loader of the main-frame document, and of the documents whose load / DOMContentLoaded fired last. */
  loaderId?: string;
  loadedLoaderId?: string;
  domContentLoaderId?: string;
  dialog: DialogInfo | null;
  loadedAt: number;
  domContentAt: number;
  navigatedAt: number;
  inflight: Map<string, number>;
  lastNetworkAt: number;
  documentResponse?: DocumentResponse;
}

/** Long-lived requests that would otherwise keep the network from ever being "idle". */
const IGNORED_FOR_IDLE = new Set(['EventSource', 'WebSocket', 'Ping']);

/** Per-tab page lifecycle the core needs everywhere: dialogs, load events, in-flight requests. */
export class TabLifecycle {
  readonly #tabs = new Map<number, Life>();
  readonly #dialogWaiters = new Map<number, Set<() => void>>();

  constructor(cdp: Cdp) {
    cdp.on((tabId, sessionId, method, params) => {
      const life = this.get(tabId);
      switch (method) {
        case 'Page.javascriptDialogOpening': {
          life.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url };
          const waiters = this.#dialogWaiters.get(tabId);
          if (waiters) for (const w of waiters) w();
          break;
        }
        case 'Page.javascriptDialogClosed':
          life.dialog = null;
          break;
        case 'Page.loadEventFired':
          if (!sessionId) {
            life.loadedAt = Date.now();
            life.loadedLoaderId = life.loaderId;
          }
          break;
        case 'Page.domContentEventFired':
          if (!sessionId) {
            life.domContentAt = Date.now();
            life.domContentLoaderId = life.loaderId;
          }
          break;
        case 'Page.frameNavigated':
          if (!sessionId && !params.frame.parentId) {
            life.mainFrameId = params.frame.id;
            life.loaderId = params.frame.loaderId;
            life.navigatedAt = Date.now();
            // A back/forward-cache restore brings back an already loaded page: no load event follows.
            if (params.type === 'BackForwardCacheRestore') {
              life.loadedAt = life.domContentAt = Date.now();
              life.loadedLoaderId = life.domContentLoaderId = life.loaderId;
            }
          }
          break;
        case 'Network.requestWillBeSent':
          if (!IGNORED_FOR_IDLE.has(params.type)) life.inflight.set(`${sessionId ?? ''}:${params.requestId}`, Date.now());
          life.lastNetworkAt = Date.now();
          if (!sessionId && params.type === 'Document' && params.frameId && params.frameId === life.mainFrameId) life.documentResponse = undefined;
          break;
        case 'Network.loadingFinished':
        case 'Network.loadingFailed':
          life.inflight.delete(`${sessionId ?? ''}:${params.requestId}`);
          life.lastNetworkAt = Date.now();
          break;
        case 'Network.responseReceived':
          if (!sessionId && params.type === 'Document' && (!life.mainFrameId || params.frameId === life.mainFrameId)) {
            const r = params.response;
            const s = r.securityDetails;
            life.documentResponse = {
              url: r.url,
              status: r.status,
              statusText: r.statusText,
              loaderId: params.loaderId,
              protocol: r.protocol,
              remoteAddress: r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : undefined,
              security: s ? { protocol: s.protocol, cipher: s.cipher, subjectName: s.subjectName, issuer: s.issuer, validTo: s.validTo } : undefined,
              at: Date.now(),
            };
          }
          break;
      }
    });
    cdp.onDetach((tabId) => this.#tabs.delete(tabId));
    chrome.tabs.onRemoved.addListener((tabId) => this.#tabs.delete(tabId));
  }

  get(tabId: number): Life {
    let life = this.#tabs.get(tabId);
    if (!life) {
      life = { dialog: null, loadedAt: 0, domContentAt: 0, navigatedAt: 0, inflight: new Map(), lastNetworkAt: 0 };
      this.#tabs.set(tabId, life);
    }
    return life;
  }

  dialog(tabId: number): DialogInfo | null {
    return this.#tabs.get(tabId)?.dialog ?? null;
  }

  /**
   * Input commands can block until a dialog they opened is closed; this
   * returns as soon as either the command finishes or a dialog opens.
   */
  async raceDialog<T>(tabId: number, promise: Promise<T>): Promise<T | undefined> {
    promise.catch(() => {}); // it may settle after we stopped waiting
    let onDialog!: () => void;
    const dialog = new Promise<undefined>((resolve) => (onDialog = () => resolve(undefined)));
    let waiters = this.#dialogWaiters.get(tabId);
    if (!waiters) this.#dialogWaiters.set(tabId, (waiters = new Set()));
    waiters.add(onDialog);
    try {
      return await Promise.race([promise, dialog]);
    } finally {
      waiters.delete(onDialog);
    }
  }

  /**
   * Waits for a load/DOMContentLoaded that happened after `after` (ms timestamp) or, when the caller started the
   * navigation and knows its `loaderId`, for that document's own event: a page left behind (such as the error page
   * of a failed navigation) can still fire its load event after the next navigation started.
   */
  async waitForLoad(tabId: number, after: number, waitUntil: string, timeoutMs: number, signal?: AbortSignal, loaderId?: string): Promise<void> {
    if (waitUntil === 'none') return;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Re-read every time: a detach/re-attach replaces the state object.
      const life = this.get(tabId);
      const reached = loaderId
        ? life.loadedLoaderId === loaderId || (waitUntil === 'domcontentloaded' && life.domContentLoaderId === loaderId)
        : waitUntil === 'domcontentloaded' ? life.domContentAt >= after || life.loadedAt >= after : life.loadedAt >= after;
      if (reached) break;
      if (life.dialog) return; // A dialog blocks the load; the caller reports it.
      if (Date.now() > deadline) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        throw new ToolError(
          `Timed out after ${timeoutMs} ms waiting for the page to ${waitUntil === 'domcontentloaded' ? 'parse' : 'load'} (tab status ${tab?.status ?? 'gone'}, ${life.inflight.size} requests in flight).`,
        );
      }
      await sleep(50, signal);
    }
    if (waitUntil === 'networkidle') await this.waitForNetworkIdle(tabId, 500, Math.max(1000, deadline - Date.now()), signal);
  }

  async waitForNetworkIdle(tabId: number, idleMs: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const life = this.get(tabId);
      // Requests stuck for over 30 s (long polling) do not count.
      for (const [id, started] of life.inflight) if (Date.now() - started > 30_000) life.inflight.delete(id);
      if (life.inflight.size === 0 && Date.now() - life.lastNetworkAt >= idleMs) return;
      if (Date.now() > deadline) throw new ToolError(`Network did not become idle within ${timeoutMs} ms (${life.inflight.size} requests still in flight).`);
      await sleep(50, signal);
    }
  }
}

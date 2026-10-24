import { PORT_BASE, PORT_COUNT } from '../../shared/constants.ts';
import type { Core } from './core.ts';
import { ToolError, withTimeout } from './util.ts';

export interface DevtoolsSelection {
  selector: string;
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  html?: string;
  at: number;
}

export interface InboxItem {
  id: number;
  kind: 'element' | 'request';
  note: string;
  data: Record<string, unknown>;
  at: number;
}

interface DevtoolsState {
  page: chrome.runtime.Port | null;
  panels: Set<chrome.runtime.Port>;
  selection: DevtoolsSelection | null;
  inbox: InboxItem[];
}

export type RevealRequest = { selector: string } | { url: string; line?: number; column?: number };

/** Message hub for the side panel and the DevTools page/panel of each inspected tab. */
export class UiHub {
  readonly #core: Core;
  readonly #sidepanels = new Set<chrome.runtime.Port>();
  readonly #devtools = new Map<number, DevtoolsState>();
  readonly #panelData = new Map<string, unknown>();
  readonly #pendingReveals = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  #nextId = 1;

  constructor(core: Core) {
    this.#core = core;
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === 'sidepanel') this.#onSidepanel(port);
      else if (port.name.startsWith('devtools-page:')) this.#onDevtoolsPage(port, Number(port.name.split(':')[1]));
      else if (port.name.startsWith('devtools-panel:')) this.#onDevtoolsPanel(port, Number(port.name.split(':')[1]));
    });
    core.activity.onEntry((entry) => {
      this.#broadcast({ type: 'activity', entry });
      if (entry.tabId !== null) for (const p of this.#devtools.get(entry.tabId)?.panels ?? []) p.postMessage({ type: 'activity', entry });
    });
  }

  #state(): Record<string, unknown> {
    const core = this.#core;
    return {
      type: 'state',
      extVersion: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id,
      ports: [PORT_BASE, PORT_BASE + PORT_COUNT - 1],
      sessions: core.sessionList(),
      activity: core.activity.list().slice(-200),
      settings: core.settings.get(),
      lan: core.lan.view(),
      data: Object.fromEntries(this.#panelData),
    };
  }

  #broadcast(msg: unknown): void {
    for (const p of this.#sidepanels) p.postMessage(msg);
  }

  /** Re-sends the full state (sessions changed, settings changed…). */
  refresh(): void {
    const state = this.#state();
    this.#broadcast(state);
    for (const [tabId, dt] of this.#devtools) for (const p of dt.panels) p.postMessage(this.#devtoolsStatus(tabId));
  }

  /** Arbitrary feature data shown in the side panel (e.g. WebMCP tools per tab). */
  setPanelData(key: string, value: unknown): void {
    this.#panelData.set(key, value);
    this.#broadcast({ type: 'data', key, value });
  }

  #onSidepanel(port: chrome.runtime.Port): void {
    this.#sidepanels.add(port);
    // Wait for the log saved before a service-worker restart, so the panel does not open empty.
    void this.#core.activity.ready.then(() => {
      if (this.#sidepanels.has(port)) port.postMessage(this.#state());
    });
    port.onDisconnect.addListener(() => this.#sidepanels.delete(port));
    port.onMessage.addListener((msg: { type: string; sessionId?: string; patch?: Record<string, unknown> }) => {
      const core = this.#core;
      switch (msg.type) {
        case 'pause':
          if (msg.sessionId) core.setPaused(msg.sessionId, true);
          break;
        case 'resume':
          if (msg.sessionId) core.setPaused(msg.sessionId, false);
          break;
        case 'stopAll':
          for (const s of core.sessions.values()) core.setPaused(s.id, true);
          break;
        case 'resumeAll':
          for (const s of core.sessions.values()) core.setPaused(s.id, false);
          break;
        case 'settings':
          void core.settings.update(msg.patch ?? {}).then(() => this.refresh());
          break;
        case 'lanNewToken':
          void core.lan.newToken();
          break;
        case 'refresh':
          port.postMessage(this.#state());
          break;
      }
    });
  }

  #dt(tabId: number): DevtoolsState {
    let s = this.#devtools.get(tabId);
    if (!s) this.#devtools.set(tabId, (s = { page: null, panels: new Set(), selection: null, inbox: [] }));
    return s;
  }

  #devtoolsStatus(tabId: number): Record<string, unknown> {
    const sessions = this.#core.sessionList().filter((s) => s.touchedTabs.includes(tabId) || s.targetTabId === tabId);
    return {
      type: 'status',
      connected: this.#core.sessions.size > 0,
      sessions,
      attached: this.#core.cdp.isAttached(tabId),
      selection: this.#dt(tabId).selection,
      inbox: this.#dt(tabId).inbox,
      activity: this.#core.activity.list().filter((e) => e.tabId === tabId).slice(-50),
    };
  }

  #onDevtoolsPage(port: chrome.runtime.Port, tabId: number): void {
    const dt = this.#dt(tabId);
    dt.page = port;
    port.onDisconnect.addListener(() => {
      if (dt.page === port) dt.page = null;
      dt.selection = null;
    });
    port.onMessage.addListener((msg: { type: string; selection?: DevtoolsSelection | null; id?: number; ok?: boolean; error?: string }) => {
      if (msg.type === 'selection') {
        dt.selection = msg.selection ? { ...msg.selection, at: Date.now() } : null;
        for (const p of dt.panels) p.postMessage({ type: 'selection', selection: dt.selection });
      } else if (msg.type === 'revealed' && msg.id !== undefined) {
        const pending = this.#pendingReveals.get(msg.id);
        this.#pendingReveals.delete(msg.id);
        if (msg.ok) pending?.resolve();
        else pending?.reject(new ToolError(msg.error ?? 'DevTools could not show it'));
      }
    });
  }

  #onDevtoolsPanel(port: chrome.runtime.Port, tabId: number): void {
    const dt = this.#dt(tabId);
    dt.panels.add(port);
    void this.#core.activity.ready.then(() => {
      if (dt.panels.has(port)) port.postMessage(this.#devtoolsStatus(tabId));
    });
    port.onDisconnect.addListener(() => dt.panels.delete(port));
    port.onMessage.addListener((msg: { type: string; kind?: 'element' | 'request'; note?: string; data?: Record<string, unknown>; id?: number }) => {
      if (msg.type === 'send' && msg.kind) {
        dt.inbox.push({ id: this.#nextId++, kind: msg.kind, note: msg.note ?? '', data: msg.data ?? {}, at: Date.now() });
        if (dt.inbox.length > 50) dt.inbox.shift();
        port.postMessage(this.#devtoolsStatus(tabId));
      } else if (msg.type === 'removeInbox' && msg.id !== undefined) {
        dt.inbox = dt.inbox.filter((i) => i.id !== msg.id);
        port.postMessage(this.#devtoolsStatus(tabId));
      }
    });
  }

  devtoolsContext(tabId: number): { open: boolean; selection: DevtoolsSelection | null; inbox: InboxItem[] } {
    const dt = this.#devtools.get(tabId);
    return { open: !!dt?.page, selection: dt?.selection ?? null, inbox: dt?.inbox ?? [] };
  }

  clearInbox(tabId: number, ids: number[]): void {
    const dt = this.#devtools.get(tabId);
    if (!dt) return;
    dt.inbox = dt.inbox.filter((i) => !ids.includes(i.id));
    for (const p of dt.panels) p.postMessage(this.#devtoolsStatus(tabId));
  }

  async reveal(tabId: number, request: RevealRequest): Promise<void> {
    const page = this.#devtools.get(tabId)?.page;
    if (!page) throw new ToolError('DevTools is not open on this tab. Ask the user to open DevTools (F12) on it, then try again.');
    const id = this.#nextId++;
    const done = new Promise<void>((resolve, reject) => this.#pendingReveals.set(id, { resolve, reject }));
    page.postMessage({ type: 'reveal', id, ...request });
    await withTimeout(done, 5000, 'DevTools did not respond.');
  }
}

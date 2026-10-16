import { Activity } from './activity.ts';
import { Cdp } from './cdp.ts';
import { Connections } from './connections.ts';
import { Dispatcher } from './dispatcher.ts';
import { Offscreen } from './offscreen.ts';
import { Overlay } from './overlay.ts';
import { PageWorld } from './page-world.ts';
import { Refs } from './refs.ts';
import type { Session } from './sessions.ts';
import { Settings } from './settings.ts';
import { TabLifecycle } from './tab-life.ts';
import type { ActionObserver, CallContext, Feature } from './types.ts';
import { UiHub } from './ui-hub.ts';
import { errorMessage, sleep } from './util.ts';
import { t } from '../i18n.ts';

export interface SessionView {
  id: string;
  name: string;
  clientVersion: string;
  port: number;
  paused: boolean;
  targetTabId: number | null;
  callCount: number;
  busy: boolean;
  connectedAt: number;
  color: string;
  touchedTabs: number[];
}

/** Everything features may use. Features never import each other — only this. */
export class Core {
  readonly cdp = new Cdp();
  readonly life = new TabLifecycle(this.cdp);
  readonly page = new PageWorld(this.cdp);
  readonly refs = new Refs(this.cdp);
  readonly settings = new Settings();
  readonly activity = new Activity();
  readonly offscreen = new Offscreen();
  readonly sessions = new Map<string, Session>();
  readonly ui: UiHub;
  readonly overlay: Overlay;
  readonly connections: Connections;
  readonly dispatcher: Dispatcher;
  readonly #sessionEndHooks: Array<(session: Session) => Promise<void> | void> = [];
  readonly #sessionStartHooks: Array<(session: Session) => void> = [];
  readonly #targetListeners: Array<(session: Session) => void> = [];
  readonly #actionObservers: ActionObserver[] = [];

  constructor(features: Feature[]) {
    this.ui = new UiHub(this);
    this.overlay = new Overlay(this);
    this.connections = new Connections(this);
    this.dispatcher = new Dispatcher(this);
    for (const feature of features) {
      feature.setup?.(this);
      if (feature.handlers) this.dispatcher.register(feature.handlers);
    }
    chrome.runtime.onMessage.addListener((msg: { neo?: string; sessionId?: string }) => {
      if (msg?.neo === 'overlay-stop' && msg.sessionId) this.setPaused(msg.sessionId, true);
      if (msg?.neo === 'overlay-resume' && msg.sessionId) this.setPaused(msg.sessionId, false);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      for (const s of this.sessions.values()) {
        s.touchedTabs.delete(tabId);
        if (s.targetTabId === tabId) {
          s.targetTabId = null;
          this.#emitTarget(s);
        }
      }
    });
  }

  async start(): Promise<void> {
    await this.settings.ready;
    this.connections.start();
    this.#updateBadge();
  }

  // ---- sessions -------------------------------------------------------

  startSession(session: Session): void {
    this.sessions.set(session.id, session);
    this.activity.note(session.id, session.name, t('activityConnected', session.name));
    for (const hook of this.#sessionStartHooks) hook(session);
    this.sessionsChanged();
  }

  async endSession(session: Session, reason: string): Promise<void> {
    this.sessions.delete(session.id);
    session.failAll(`The session ended: ${reason}.`);
    for (const hook of this.#sessionEndHooks) {
      try {
        await hook(session);
      } catch (error) {
        console.warn('[neo-webmcp] session cleanup failed', errorMessage(error));
      }
    }
    // Detach from tabs no other session uses (BRD 2.2.1: nothing stays attached for an ended session).
    const stillUsed = new Set([...this.sessions.values()].flatMap((s) => [...s.touchedTabs]));
    for (const tabId of session.touchedTabs) {
      await this.overlay.remove(tabId);
      if (!stillUsed.has(tabId)) await this.cdp.detach(tabId);
    }
    this.activity.note(session.id, session.name, t('activityDisconnected', session.name));
    this.sessionsChanged();
  }

  onSessionStart(hook: (session: Session) => void): void {
    this.#sessionStartHooks.push(hook);
  }

  /** Cleanup hook run when a session ends (remove emulation, mocks…). */
  onSessionEnd(hook: (session: Session) => Promise<void> | void): void {
    this.#sessionEndHooks.push(hook);
  }

  setPaused(sessionId: string, paused: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.paused === paused) return;
    session.paused = paused;
    if (paused) for (const ac of session.inflight.values()) ac.abort();
    this.activity.note(session.id, session.name, t(paused ? 'activityPaused' : 'activityResumed', session.name));
    void this.overlay.sessionPaused(session);
    this.sessionsChanged();
  }

  setTarget(session: Session, tabId: number | null): void {
    session.targetTabId = tabId;
    this.#emitTarget(session);
    this.sessionsChanged();
  }

  onTargetChange(listener: (session: Session) => void): void {
    this.#targetListeners.push(listener);
  }

  #emitTarget(session: Session): void {
    for (const l of this.#targetListeners) l(session);
  }

  sessionList(): SessionView[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      clientVersion: s.client?.version ?? '',
      port: s.port,
      paused: s.paused,
      targetTabId: s.targetTabId,
      callCount: s.callCount,
      busy: s.inflight.size > 0,
      connectedAt: s.connectedAt,
      color: s.color,
      touchedTabs: [...s.touchedTabs],
    }));
  }

  sessionsChanged(): void {
    this.ui.refresh();
    this.#updateBadge();
  }

  #updateBadge(): void {
    const sessions = [...this.sessions.values()];
    const paused = sessions.some((s) => s.paused);
    void chrome.action.setBadgeText({ text: sessions.length ? (paused ? '❚❚' : String(sessions.length)) : '' });
    void chrome.action.setBadgeBackgroundColor({ color: paused ? '#d97706' : '#16a34a' });
    void chrome.action.setTitle({ title: sessions.length ? t('actionTitleConnected', String(sessions.length)) : t('actionTitle') });
  }

  /** DevTools target id of a tab (used to reach the same page through the full DevTools channel). */
  async targetIdFor(tabId: number): Promise<string> {
    const target = (await chrome.debugger.getTargets()).find((t) => t.tabId === tabId && t.type === 'page');
    if (!target) throw new Error(`No DevTools target for tab ${tabId}`);
    return target.id;
  }

  // ---- actions --------------------------------------------------------

  addActionObserver(observer: ActionObserver): void {
    this.#actionObservers.push(observer);
  }

  /**
   * Runs an input action and reports what it changed: navigation, new tabs
   * (grouped with the session), an open dialog, observer notes (console errors).
   */
  async observeAction<T>(ctx: CallContext, run: () => Promise<T>): Promise<{ value: T; notes: string[] }> {
    const { tabId, session } = ctx;
    const started = Date.now();
    const before = await chrome.tabs.get(tabId).catch(() => null);
    const opened: number[] = [];
    const onCreated = (tab: chrome.tabs.Tab) => {
      if (tab.openerTabId === tabId && tab.id !== undefined) opened.push(tab.id);
    };
    chrome.tabs.onCreated.addListener(onCreated);
    let value: T;
    try {
      value = await run();
      await sleep(250, ctx.signal); // let navigations, dialogs and popups start
    } finally {
      chrome.tabs.onCreated.removeListener(onCreated);
    }
    const notes: string[] = [];
    const life = this.life.get(tabId);
    if (life.navigatedAt >= started) {
      await this.life.waitForLoad(tabId, started, 'domcontentloaded', 10_000, ctx.signal).catch(() => {});
      const after = await chrome.tabs.get(tabId).catch(() => null);
      notes.push(`Navigated to ${after?.url ?? 'a new page'}${after?.title ? ` ("${after.title}")` : ''}. Refs from the previous page are no longer valid.`);
    } else {
      const after = await chrome.tabs.get(tabId).catch(() => null);
      if (before && after && before.url !== after.url) notes.push(`URL changed to ${after.url} (same-document navigation).`);
    }
    for (const id of opened) {
      await session.addToGroup(id);
      const tab = await chrome.tabs.get(id).catch(() => null);
      notes.push(`Opened new tab ${id}${tab?.pendingUrl || tab?.url ? ` (${tab.pendingUrl || tab.url})` : ''}; use tab_select to work in it.`);
    }
    const dialog = this.life.dialog(tabId);
    if (dialog) notes.push(`A ${dialog.type} dialog is open: "${dialog.message}". Use the dialog tool to accept or dismiss it.`);
    for (const observer of this.#actionObservers) {
      try {
        notes.push(...observer(tabId, started));
      } catch {
        /* observers are best effort */
      }
    }
    return { value, notes };
  }
}

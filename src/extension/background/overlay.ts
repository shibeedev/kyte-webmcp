import type { Core } from './core.ts';
import type { Session } from './sessions.ts';
import { t } from '../i18n.ts';

/** How long the indicator stays after the agent's last action. */
const IDLE_HIDE_MS = 4000;

export interface OverlayMessage {
  neo: 'overlay';
  action: 'show' | 'hide' | 'suspend' | 'unsuspend' | 'remove';
  label?: string;
  stopLabel?: string;
  resumeLabel?: string;
  pausedLabel?: string;
  paused?: boolean;
  sessionId?: string;
}

/**
 * The in-page "agent is controlling this tab" indicator. The content script
 * is only injected into tabs the agent acts on, never declared for all pages.
 */
export class Overlay {
  readonly #core: Core;
  readonly #injected = new Set<number>();
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly #suspended = new Map<number, number>();

  constructor(core: Core) {
    this.#core = core;
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.status === 'loading') this.#injected.delete(tabId);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.#injected.delete(tabId);
      clearTimeout(this.#timers.get(tabId));
      this.#timers.delete(tabId);
    });
    core.settings.onChange((s) => {
      if (!s.overlay) for (const tabId of this.#injected) void this.#send(tabId, { neo: 'overlay', action: 'remove' });
    });
  }

  async #ensure(tabId: number): Promise<boolean> {
    if (this.#injected.has(tabId)) return true;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
      this.#injected.add(tabId);
      return true;
    } catch {
      return false; // protected pages
    }
  }

  async #send(tabId: number, msg: OverlayMessage): Promise<void> {
    await chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }

  #message(session: Session, action: OverlayMessage['action']): OverlayMessage {
    return {
      neo: 'overlay',
      action,
      label: t('overlayLabel', session.name),
      stopLabel: t('stop'),
      resumeLabel: t('resume'),
      pausedLabel: t('overlayPaused'),
      paused: session.paused,
      sessionId: session.id,
    };
  }

  /** Shows the indicator on agent activity and schedules it to fade out. */
  async activity(tabId: number, session: Session): Promise<void> {
    if (!this.#core.settings.get().overlay || this.#suspended.has(tabId)) return;
    if (!(await this.#ensure(tabId))) return;
    await this.#send(tabId, this.#message(session, 'show'));
    clearTimeout(this.#timers.get(tabId));
    if (!session.paused) {
      this.#timers.set(
        tabId,
        setTimeout(() => {
          if (!session.inflight.size) void this.#send(tabId, { neo: 'overlay', action: 'hide' });
        }, IDLE_HIDE_MS),
      );
    }
  }

  /** Hides the indicator while `capture` runs so it never appears in screenshots or frames. */
  async withHidden<T>(tabId: number, capture: () => Promise<T>): Promise<T> {
    this.#suspended.set(tabId, (this.#suspended.get(tabId) ?? 0) + 1);
    const wasInjected = this.#injected.has(tabId);
    if (wasInjected) await chrome.tabs.sendMessage(tabId, { neo: 'overlay', action: 'suspend' } satisfies OverlayMessage).catch(() => {});
    try {
      return await capture();
    } finally {
      const n = (this.#suspended.get(tabId) ?? 1) - 1;
      if (n <= 0) {
        this.#suspended.delete(tabId);
        if (wasInjected) await this.#send(tabId, { neo: 'overlay', action: 'unsuspend' });
      } else this.#suspended.set(tabId, n);
    }
  }

  async sessionPaused(session: Session): Promise<void> {
    for (const tabId of session.touchedTabs) {
      if (this.#injected.has(tabId)) await this.#send(tabId, this.#message(session, session.paused ? 'show' : 'hide'));
    }
  }

  async remove(tabId: number): Promise<void> {
    clearTimeout(this.#timers.get(tabId));
    if (this.#injected.has(tabId)) await this.#send(tabId, { neo: 'overlay', action: 'remove' });
    this.#injected.delete(tabId);
  }
}

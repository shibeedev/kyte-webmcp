export interface ActivityEntry {
  id: number;
  sessionId: string;
  client: string;
  tool: string;
  args: string;
  tabId: number | null;
  startedAt: number;
  durationMs?: number;
  status: 'running' | 'ok' | 'error';
  summary?: string;
}

const MAX_ENTRIES = 300;

/** Values that should not be shown in the activity log. */
const SENSITIVE_KEYS = /pass(word)?|secret|token|otp|pin|cvv|card/i;

export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    let s = SENSITIVE_KEYS.test(k) ? '•••' : typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}…` : v) : JSON.stringify(v);
    if (s && s.length > 80) s = `${s.slice(0, 77)}…`;
    parts.push(`${k}=${s}`);
  }
  return parts.join(' ');
}

const STORE_KEY = 'activityLog';

/**
 * Live log of agent tool calls for the side panel and DevTools panel. Chrome stops the service worker
 * when idle, so the log is kept in session storage: it survives those restarts and is cleared when Chrome closes.
 */
export class Activity {
  #entries: ActivityEntry[] = [];
  // Time-based so ids stay unique across service-worker restarts.
  #nextId = Date.now();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #listeners = new Set<(e: ActivityEntry) => void>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = chrome.storage.session.get(STORE_KEY).then(
      (stored) => {
        const saved = (stored[STORE_KEY] as ActivityEntry[] | undefined) ?? [];
        for (const e of saved) {
          if (e.status === 'running') {
            e.status = 'error';
            e.summary = 'Interrupted: the extension restarted while this was running.';
          }
        }
        this.#entries = [...saved, ...this.#entries].slice(-MAX_ENTRIES);
      },
      () => {},
    );
  }

  start(sessionId: string, client: string, tool: string, args: Record<string, unknown>, tabId: number | null): ActivityEntry {
    const entry: ActivityEntry = { id: this.#nextId++, sessionId, client, tool, args: summarizeArgs(args), tabId, startedAt: Date.now(), status: 'running' };
    this.#add(entry);
    return entry;
  }

  finish(entry: ActivityEntry, ok: boolean, summary: string): void {
    entry.status = ok ? 'ok' : 'error';
    entry.durationMs = Date.now() - entry.startedAt;
    entry.summary = summary.length > 300 ? `${summary.slice(0, 297)}…` : summary;
    this.#emit(entry);
  }

  note(sessionId: string, client: string, text: string): void {
    this.#add({ id: this.#nextId++, sessionId, client, tool: '·', args: '', tabId: null, startedAt: Date.now(), durationMs: 0, status: 'ok', summary: text });
  }

  #add(entry: ActivityEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > MAX_ENTRIES) this.#entries = this.#entries.slice(-MAX_ENTRIES);
    this.#emit(entry);
  }

  #save(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void chrome.storage.session.set({ [STORE_KEY]: this.#entries }).catch(() => {}), 250);
  }

  list(): ActivityEntry[] {
    return this.#entries;
  }

  onEntry(listener: (e: ActivityEntry) => void): void {
    this.#listeners.add(listener);
  }

  #emit(entry: ActivityEntry): void {
    this.#save();
    for (const l of this.#listeners) l(entry);
  }
}

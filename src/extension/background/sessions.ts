import type { ClientInfo, ExtToBridge } from '../../shared/protocol.ts';
import { ToolError } from './util.ts';

const GROUP_COLORS: `${chrome.tabGroups.Color}`[] = ['purple', 'cyan', 'orange', 'green', 'pink', 'blue', 'yellow', 'red'];

/** One MCP client connected through one bridge. */
export class Session {
  readonly id: string;
  readonly port: number;
  readonly connectedAt = Date.now();
  readonly color: `${chrome.tabGroups.Color}`;
  client: ClientInfo | null = null;
  bridgeVersion = '';
  paused = false;
  /** Explicitly chosen target (tab_select / tab_open). null = follow the user's active tab. */
  targetTabId: number | null = null;
  callCount = 0;
  readonly inflight = new Map<number, AbortController>();
  /** Tabs this session acted on, for cleanup when it ends. */
  readonly touchedTabs = new Set<number>();
  /** windowId -> tab group id of this session. */
  readonly groups = new Map<number, number>();
  readonly #send: (msg: ExtToBridge) => void;
  readonly #pendingServices = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextServiceId = 1;

  constructor(port: number, index: number, send: (msg: ExtToBridge) => void) {
    this.id = `bridge-${port}`;
    this.port = port;
    this.color = GROUP_COLORS[index % GROUP_COLORS.length]!;
    this.#send = send;
  }

  get name(): string {
    return this.client?.name ?? `MCP client :${this.port}`;
  }

  send(msg: ExtToBridge): void {
    this.#send(msg);
  }

  /** Calls a service on this session's bridge (file writes, Whisper, trace analysis, full DevTools). */
  service<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextServiceId++;
    return new Promise<T>((resolve, reject) => {
      this.#pendingServices.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send({ t: 'svc', id, name, args });
    });
  }

  resolveService(id: number, ok: boolean, value: unknown, error?: string): void {
    const p = this.#pendingServices.get(id);
    if (!p) return;
    this.#pendingServices.delete(id);
    if (ok) p.resolve(value);
    else p.reject(new ToolError(error ?? 'bridge service failed'));
  }

  failAll(reason: string): void {
    for (const p of this.#pendingServices.values()) p.reject(new ToolError(reason));
    this.#pendingServices.clear();
    for (const ac of this.inflight.values()) ac.abort();
  }

  async writeFile(opts: { path?: string; stem: string; ext: string; data: string; encoding: 'base64' | 'utf8' }): Promise<{ path: string; bytes: number }> {
    return this.service('file.write', opts);
  }

  /** Streams large data to a file on the bridge in chunks. */
  async streamFile(opts: { path?: string; stem: string; ext: string }, produce: (write: (data: string, encoding: 'base64' | 'utf8') => Promise<void>) => Promise<void>): Promise<{ path: string; bytes: number }> {
    const { handle } = await this.service<{ handle: number }>('file.open', opts);
    let failure: unknown;
    try {
      await produce(async (data, encoding) => {
        await this.service('file.append', { handle, data, encoding });
      });
    } catch (error) {
      failure = error;
    }
    const closed = await this.service<{ path: string; bytes: number }>('file.close', { handle });
    if (failure) throw failure;
    return closed;
  }

  /** Puts a tab into this session's group in that tab's window. */
  async addToGroup(tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      let groupId = this.groups.get(tab.windowId);
      if (groupId !== undefined) {
        try {
          await chrome.tabGroups.get(groupId);
        } catch {
          groupId = undefined; // the user closed or ungrouped it
        }
      }
      groupId = await chrome.tabs.group(groupId !== undefined ? { tabIds: [tabId], groupId } : { tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      this.groups.set(tab.windowId, groupId);
      await chrome.tabGroups.update(groupId, { title: this.name, color: this.color });
    } catch (error) {
      console.warn('[neo-webmcp] grouping failed', error);
    }
  }
}

/** The tab a tool acts on: explicit tabId, then the session target, then the user's active tab. */
export async function resolveTargetTab(session: Session, requested: unknown): Promise<number> {
  if (typeof requested === 'number') {
    try {
      await chrome.tabs.get(requested);
      return requested;
    } catch {
      throw new ToolError(`Tab ${requested} does not exist. Use tabs_list to see open tabs.`);
    }
  }
  if (session.targetTabId !== null) {
    try {
      await chrome.tabs.get(session.targetTabId);
      return session.targetTabId;
    } catch {
      session.targetTabId = null; // closed: fall back to the active tab
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (active?.id !== undefined) return active.id;
  const [any] = await chrome.tabs.query({ active: true, windowType: 'normal' });
  if (any?.id !== undefined) return any.id;
  throw new ToolError('There is no open browser tab. Use tab_open to open one.');
}

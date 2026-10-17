import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { BROKER_PATH, readBrokerInfo } from './broker.ts';
import type { EndpointHints } from './discovery.ts';

export interface FullCdpStatus {
  state: 'idle' | 'connecting' | 'connected' | 'failed' | 'unavailable';
  error?: string;
  source?: string;
  silent?: boolean;
}

type EventListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

export const FULL_CDP_HELP =
  'The full DevTools channel is not available. Either start the dedicated agent browser with "kyte-webmcp chrome" (no prompts), or enable remote debugging once in your Chrome at chrome://inspect/#remote-debugging and click "Allow" when Chrome asks (once per Chrome start).';

/**
 * Bridge-side client of the broker. Every bridge shares the broker's single
 * browser connection, so Chrome's consent prompt appears at most once per run.
 */
export class FullCdpClient {
  readonly #cliPath: string;
  #ws: WebSocket | null = null;
  #connecting: Promise<void> | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #listeners = new Set<EventListener>();
  readonly #sessions = new Map<string, string>(); // targetId -> sessionId
  #status: FullCdpStatus = { state: 'idle' };

  constructor(cliPath: string) {
    this.#cliPath = cliPath;
  }

  status(): FullCdpStatus {
    return this.#status;
  }

  isConnected(): boolean {
    return this.#status.state === 'connected' && this.#ws?.readyState === WebSocket.OPEN;
  }

  on(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Connects (spawning the broker when needed) and waits until the browser connection is up. */
  async ensure(): Promise<void> {
    if (this.isConnected()) return;
    this.#connecting ??= this.#connect().finally(() => (this.#connecting = null));
    await this.#connecting;
    if (!this.isConnected()) throw new Error(`${FULL_CDP_HELP} (${this.#status.error ?? this.#status.state})`);
  }

  async #connect(): Promise<void> {
    this.#status = { state: 'connecting' };
    let ws = await this.#openBroker();
    if (!ws) {
      spawn(process.execPath, [this.#cliPath, 'broker'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      for (let i = 0; i < 50 && !ws; i++) {
        await new Promise((r) => setTimeout(r, 100));
        ws = await this.#openBroker();
      }
    }
    if (!ws) {
      this.#status = { state: 'unavailable', error: 'could not start the kyte-webmcp broker' };
      return;
    }
    this.#ws = ws;
    ws.on('message', (data) => this.#onMessage(String(data)));
    ws.on('close', () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#sessions.clear();
      this.#status = { state: 'idle' };
      for (const p of this.#pending.values()) p.reject(new Error('full DevTools channel closed'));
      this.#pending.clear();
    });
    // The broker may have been started by another bridge: tell it where this bridge was told to look.
    const hints: EndpointHints = { endpoint: process.env.KYTE_WEBMCP_CDP_ENDPOINT, userDataDir: process.env.KYTE_WEBMCP_CHROME_USER_DATA_DIR };
    const status = (await this.#call('Broker.connect', { ...hints })) as FullCdpStatus;
    this.#status = status;
  }

  async #openBroker(): Promise<WebSocket | null> {
    const info = readBrokerInfo();
    if (!info) return null;
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}${BROKER_PATH}`, { headers: { authorization: `Bearer ${info.token}` }, maxPayload: 512 * 1024 * 1024 });
    return new Promise((resolve) => {
      ws.once('open', () => resolve(ws));
      ws.once('error', () => resolve(null));
      ws.once('unexpected-response', () => resolve(null));
    });
  }

  #onMessage(raw: string): void {
    const msg = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Target.detachedFromTarget') {
      for (const [t, s] of this.#sessions) if (s === msg.params?.sessionId) this.#sessions.delete(t);
    }
    if (msg.method) for (const l of this.#listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
  }

  #call(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('full DevTools channel is not connected'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    await this.ensure();
    return (await this.#call(method, params, sessionId)) as T;
  }

  /** Returns a flattened CDP session for a page target (shared across calls). */
  async sessionFor(targetId: string): Promise<string> {
    await this.ensure();
    const known = this.#sessions.get(targetId);
    if (known) return known;
    const { sessionId } = (await this.#call('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    this.#sessions.set(targetId, sessionId);
    return sessionId;
  }

  close(): void {
    this.#ws?.close();
  }
}

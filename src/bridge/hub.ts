import { createServer, type IncomingMessage, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { EXTENSION_ORIGIN, PORT_BASE, PORT_COUNT, PROTOCOL_VERSION, WS_PATH } from '../shared/constants.ts';
import { CLOSE_BUSY, CLOSE_PROTOCOL, type BridgeToExt, type ClientInfo, type ExtToBridge, type PageTool, type ToolResult } from '../shared/protocol.ts';
import { log } from './log.ts';

export type ServiceHandler = (args: Record<string, unknown>) => Promise<unknown>;

interface PendingCall {
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
}

/** A socket that has not pinged for this long is considered dead and may be replaced. */
const STALE_MS = 45_000;

/**
 * Loopback WebSocket endpoint the extension connects to. Only the Neo WebMCP
 * extension origin is accepted; web pages cannot forge the Origin header.
 */
export class ExtensionHub extends EventEmitter {
  port = 0;
  extension: { version: string; userAgent: string } | null = null;
  client: ClientInfo | null = null;
  readonly #version: string;
  readonly #cliPath: string;
  readonly #services: Record<string, ServiceHandler>;
  #server: Server | null = null;
  #wss: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #lastSeen = 0;
  #nextId = 1;
  readonly #pending = new Map<number, PendingCall>();

  constructor(version: string, services: Record<string, ServiceHandler>, cliPath = '') {
    super();
    this.#version = version;
    this.#cliPath = cliPath;
    this.#services = services;
  }

  /** Binds the first free port of the shared range (or `preferred` when given). */
  async listen(preferred?: number): Promise<number> {
    const candidates = preferred ? [preferred] : Array.from({ length: PORT_COUNT }, (_, i) => PORT_BASE + i);
    for (const port of candidates) {
      if (await this.#tryListen(port)) return (this.port = port);
    }
    throw new Error(`No free port in ${candidates[0]}-${candidates.at(-1)}; too many neo-webmcp bridges running?`);
  }

  #tryListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(404).end();
      });
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        this.#server = server;
        this.#wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 256 * 1024 * 1024, verifyClient: (info: { origin: string; req: IncomingMessage }) => this.#verify(info) });
        this.#wss.on('connection', (ws) => this.#onConnection(ws));
        resolve(true);
      });
    });
  }

  #verify(info: { origin: string; req: IncomingMessage }): boolean {
    const host = info.req.headers.host ?? '';
    const hostOk = host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
    if (info.origin !== EXTENSION_ORIGIN || !hostOk) {
      log(`rejected connection from origin=${info.origin || '(none)'} host=${host}`);
      return false;
    }
    return true;
  }

  #onConnection(ws: WebSocket): void {
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN && Date.now() - this.#lastSeen < STALE_MS) {
      ws.close(CLOSE_BUSY, 'bridge already serves another extension instance');
      return;
    }
    this.#socket?.terminate();
    this.#socket = ws;
    this.#lastSeen = Date.now();
    ws.on('message', (data) => this.#onMessage(ws, String(data)));
    ws.on('close', () => {
      if (this.#socket !== ws) return;
      this.#socket = null;
      this.extension = null;
      for (const [id, pending] of this.#pending) {
        pending.reject(new Error('The Neo WebMCP extension disconnected while the command was running.'));
        this.#pending.delete(id);
      }
      log('extension disconnected');
      this.emit('disconnected');
    });
    this.#send({ t: 'welcome', bridgeVersion: this.#version, pid: process.pid, port: this.port, client: this.client, cliPath: this.#cliPath });
  }

  #onMessage(ws: WebSocket, raw: string): void {
    this.#lastSeen = Date.now();
    let msg: ExtToBridge;
    try {
      msg = JSON.parse(raw) as ExtToBridge;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello':
        if (msg.protocol !== PROTOCOL_VERSION) {
          ws.close(CLOSE_PROTOCOL, `protocol ${msg.protocol} unsupported (bridge speaks ${PROTOCOL_VERSION})`);
          return;
        }
        this.extension = { version: msg.extVersion, userAgent: msg.userAgent };
        log(`extension ${msg.extVersion} connected`);
        this.emit('connected');
        break;
      case 'ping':
        this.#send({ t: 'pong' });
        break;
      case 'result': {
        const pending = this.#pending.get(msg.id);
        if (pending) {
          this.#pending.delete(msg.id);
          pending.resolve(msg.result);
        }
        break;
      }
      case 'svc':
        void this.#runService(msg.id, msg.name, msg.args);
        break;
      case 'page_tools':
        this.emit('page_tools', msg.tools as PageTool[]);
        break;
    }
  }

  async #runService(id: number, name: string, args: Record<string, unknown>): Promise<void> {
    const handler = this.#services[name];
    try {
      if (!handler) throw new Error(`Unknown bridge service "${name}"`);
      this.#send({ t: 'svc_result', id, ok: true, value: await handler(args) });
    } catch (error) {
      this.#send({ t: 'svc_result', id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  #send(msg: BridgeToExt): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(msg));
  }

  isConnected(): boolean {
    return this.extension !== null && this.#socket?.readyState === WebSocket.OPEN;
  }

  setClient(client: ClientInfo): void {
    this.client = client;
    this.#send({ t: 'client', client });
  }

  /** Resolves once the extension has said hello, or rejects after `timeoutMs`. */
  waitForExtension(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        this.off('connected', onConnected);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onConnected = () => done();
      const onAbort = () => done(new Error('Cancelled'));
      const timer = setTimeout(() => done(new Error(NOT_CONNECTED_HELP)), timeoutMs);
      this.on('connected', onConnected);
      signal?.addEventListener('abort', onAbort);
    });
  }

  /** Runs a tool in the extension. Cancelling the signal tells the extension to abort it. */
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (!this.isConnected()) return Promise.reject(new Error(NOT_CONNECTED_HELP));
    const id = this.#nextId++;
    return new Promise<ToolResult>((resolve, reject) => {
      const onAbort = () => {
        this.#send({ t: 'cancel', id });
        this.#pending.delete(id);
        reject(new Error('Cancelled by the MCP client'));
      };
      this.#pending.set(id, {
        resolve: (r) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#send({ t: 'call', id, tool, args });
    });
  }

  async close(): Promise<void> {
    this.#socket?.close();
    this.#wss?.close();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}

export const NOT_CONNECTED_HELP =
  'The Neo WebMCP Chrome extension is not connected to this bridge. Check that Chrome is running, that the Neo WebMCP extension is installed and enabled (chrome://extensions), and open its side panel to see the connection status.';

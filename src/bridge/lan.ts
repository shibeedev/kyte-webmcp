import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { LAN_PATH, LAN_PORT } from '../shared/constants.ts';
import type { ExtToLanHost, LanHostToExt } from '../shared/protocol.ts';
import { encodeNative, NativeReader } from './native-host.ts';
import { log } from './log.ts';
import type { BridgeContext } from './types.ts';

/** Builds one bridge (extension hub + MCP server) for a LAN client. */
export type BridgeFactory = (remote: string) => { ctx: BridgeContext; server: McpServer };

/**
 * A session with no open request or stream for this long is parked: its
 * extension session ends (tabs released, indicator gone) until the client calls
 * again. MCP clients that keep the standalone SSE stream open are never parked
 * while they run, so this mostly catches clients that went away without saying so.
 */
const PARK_AFTER_MS = 60_000;
/** Parked sessions are forgotten after this long; the client then has to reconnect. */
const FORGET_AFTER_MS = 24 * 60 * 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

interface LanSession {
  remote: string;
  ctx: BridgeContext;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** HTTP requests and SSE streams currently open. */
  open: number;
  lastSeen: number;
  parked: boolean;
  reviving: Promise<void> | null;
}

/** Strips the IPv4-mapped IPv6 prefix Node reports on dual-stack sockets. */
export function normalizeAddress(address: string | undefined): string {
  const a = address ?? '';
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice(7) : a;
}

/** Loopback, private (RFC 1918, unique local) and link-local addresses: devices on the same local network. */
export function isPrivateAddress(address: string): boolean {
  const a = normalizeAddress(address).toLowerCase();
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (v4) {
    const [p, q] = [Number(v4[1]), Number(v4[2])];
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

/** Private IPv4 addresses of this machine, physical adapters first (virtual ones belong to VMs, WSL, Docker…). */
export function lanAddresses(): string[] {
  const virtual = /vethernet|wsl|hyper-v|virtualbox|vmware|vbox|docker|br-|veth|bluetooth|tailscale|zerotier|utun/i;
  const found: Array<{ address: string; virtual: boolean }> = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && isPrivateAddress(info.address) && !info.address.startsWith('169.254.')) found.push({ address: info.address, virtual: virtual.test(name) });
    }
  }
  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual)).map((f) => f.address);
}

const digest = (token: string) => createHash('sha256').update(token).digest();

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: status === 404 ? -32001 : -32000, message }, id: null }));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * MCP over Streamable HTTP for other machines on the LAN. Every MCP session gets
 * its own bridge (a hub on the loopback port range + an MCP server), exactly
 * like a stdio bridge, so to the extension it is one more session.
 */
export class LanGateway {
  readonly #factory: BridgeFactory;
  readonly #onBridge: () => void;
  readonly #sessions = new Map<string, LanSession>();
  readonly #sweep: NodeJS.Timeout;
  #token: Buffer | null = null;
  #server: Server | null = null;

  /** `onBridge` runs whenever a session's hub starts listening, so the extension can connect without waiting for its next scan. */
  constructor(factory: BridgeFactory, onBridge: () => void) {
    this.#factory = factory;
    this.#onBridge = onBridge;
    this.#sweep = setInterval(() => void this.#sweepSessions(), 10_000);
    this.#sweep.unref();
  }

  get port(): number {
    const address = this.#server?.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  /** Sets the access token. A different token disconnects every client that used the old one. */
  async setToken(token: string): Promise<void> {
    const next = digest(token);
    if (this.#token && !this.#token.equals(next)) await Promise.all([...this.#sessions.keys()].map((id) => this.#end(id)));
    this.#token = next;
  }

  /** Listens on every interface; the address filter in the handler keeps it to the local network. */
  listen(port = LAN_PORT): Promise<void> {
    if (this.#server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.#handle(req, res));
      server.once('error', reject);
      server.listen(port, () => {
        server.off('error', reject);
        this.#server = server;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.#sweep);
    await Promise.all([...this.#sessions.keys()].map((id) => this.#end(id)));
    const server = this.#server;
    this.#server = null;
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  #authorized(header: string | undefined): boolean {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    return !!match && !!this.#token && timingSafeEqual(digest(match[1]!), this.#token);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const remote = normalizeAddress(req.socket.remoteAddress);
      if (!isPrivateAddress(remote)) return reply(res, 403, 'Only devices on the local network may connect.');
      if (new URL(req.url ?? '/', 'http://lan').pathname !== LAN_PATH) return reply(res, 404, `Not found. The MCP endpoint is ${LAN_PATH}.`);
      // Browsers always send Origin and MCP clients do not: web pages on the LAN cannot use the endpoint.
      if (req.headers.origin !== undefined) return reply(res, 403, 'Requests from web pages are not accepted.');
      if (!this.#authorized(req.headers.authorization)) return reply(res, 401, 'Missing or wrong access token. Copy the connection command from the Kyte WebMCP side panel on the browser machine.');
      let body: unknown;
      if (req.method === 'POST') {
        body = await readJson(req).catch(() => undefined);
        if (body === undefined) return reply(res, 400, 'The request body is not valid JSON.');
      }
      const sid = req.headers['mcp-session-id'];
      let session = typeof sid === 'string' ? this.#sessions.get(sid) : undefined;
      if (!session) {
        if (sid !== undefined) return reply(res, 404, 'Session not found');
        if (!isInitializeRequest(body)) return reply(res, 400, 'Bad Request: no valid session ID');
        session = await this.#create(remote);
      }
      await this.#serve(session, req, res, body);
      if (!session.transport.sessionId) await this.#close(session); // initialization failed
    } catch (error) {
      log('LAN request failed:', error);
      reply(res, 500, error instanceof Error ? error.message : String(error));
    }
  }

  async #create(remote: string): Promise<LanSession> {
    const { ctx, server } = this.#factory(remote);
    try {
      await ctx.hub.listen();
    } catch (error) {
      ctx.fullCdp.close();
      throw error;
    }
    const session: LanSession = { remote, ctx, server, transport: null as unknown as StreamableHTTPServerTransport, open: 0, lastSeen: Date.now(), parked: false, reviving: null };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.#sessions.set(id, session);
        log(`LAN client ${remote} connected`);
      },
      onsessionclosed: (id) => this.#end(id),
    });
    await server.connect(session.transport);
    this.#onBridge();
    return session;
  }

  async #serve(session: LanSession, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    if (session.parked) {
      session.reviving ??= session.ctx.hub
        .listen()
        .then(() => {
          session.parked = false;
          this.#onBridge();
        })
        .finally(() => (session.reviving = null));
      await session.reviving;
    }
    session.open++;
    session.lastSeen = Date.now();
    res.on('close', () => {
      session.open--;
      session.lastSeen = Date.now();
    });
    await session.transport.handleRequest(req, res, body);
  }

  async #sweepSessions(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.open > 0 || session.reviving) continue;
      if (session.parked && now - session.lastSeen > FORGET_AFTER_MS) await this.#end(id);
      else if (!session.parked && now - session.lastSeen > PARK_AFTER_MS) {
        session.parked = true;
        await session.ctx.hub.close().catch(() => {});
        log(`LAN client ${session.remote} went quiet; its browser session is released until it calls again`);
      }
    }
  }

  async #end(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    await this.#close(session);
    log(`LAN client ${session.remote} disconnected`);
  }

  async #close(session: LanSession): Promise<void> {
    session.ctx.fullCdp.close();
    await session.server.close().catch(() => {});
    await session.ctx.hub.close().catch(() => {});
  }
}

/**
 * `kyte-webmcp lan-host`: Chrome starts it over native messaging while the user
 * allows LAN connections, and closes its stdin when the user turns that off or
 * Chrome exits.
 */
export function runLanHost(factory: BridgeFactory): void {
  const send = (message: LanHostToExt) => process.stdout.write(encodeNative(message));
  const gateway = new LanGateway(factory, () => send({ t: 'scan' }));
  let listening: Promise<void> | null = null;
  const listen = async (): Promise<void> => {
    for (;;) {
      try {
        await gateway.listen();
        log(`LAN endpoint listening on port ${gateway.port}`);
        send({ t: 'listening', port: gateway.port, addresses: lanAddresses() });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        send({ t: 'error', message: code === 'EADDRINUSE' ? `Port ${LAN_PORT} is already in use by another program.` : error instanceof Error ? error.message : String(error) });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };
  const reader = new NativeReader((raw) => {
    const message = raw as ExtToLanHost;
    if (message?.t === 'start' && typeof message.token === 'string') void gateway.setToken(message.token).then(() => (listening ??= listen()));
  });
  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(0), 2000).unref();
    void gateway.close().finally(() => process.exit(0));
  };
  process.stdin.on('data', (chunk: Buffer) => reader.push(chunk));
  process.stdin.once('end', exit);
  process.stdin.once('error', exit);
  process.stdout.on('error', exit);
}

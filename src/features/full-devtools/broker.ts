/**
 * Long-lived process that holds ONE remote-debugging connection to the
 * browser and shares it with every bridge on this machine. Holding a single
 * connection means Chrome asks for consent once per browser run instead of
 * once per agent session. It exits when the browser connection closes.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { EXTENSION_ID } from '../../shared/constants.ts';
import { discoverEndpoints, type Endpoint, type EndpointHints } from './discovery.ts';

export const BROKER_PORT_BASE = 17820;
export const BROKER_PORT_COUNT = 10;
export const BROKER_PATH = '/kyte-webmcp-broker';

export function brokerInfoFile(): string {
  return path.join(process.env.KYTE_WEBMCP_STATE_DIR ?? path.join(os.homedir(), '.kyte-webmcp'), 'broker.json');
}

export interface BrokerInfo {
  pid: number;
  port: number;
  token: string;
}

export function readBrokerInfo(): BrokerInfo | null {
  try {
    return JSON.parse(readFileSync(brokerInfoFile(), 'utf8')) as BrokerInfo;
  } catch {
    return null;
  }
}

type BrokerState = 'idle' | 'connecting' | 'connected' | 'failed';

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
}

function blog(...parts: unknown[]): void {
  process.stderr.write(`[kyte-webmcp broker] ${parts.map(String).join(' ')}\n`);
}

export async function runBroker(): Promise<void> {
  const token = randomBytes(24).toString('hex');
  let state: BrokerState = 'idle';
  let lastError = '';
  let endpoint: Endpoint | null = null;
  let browser: WebSocket | null = null;
  let connecting: Promise<void> | null = null;
  let nextBrowserId = 1;
  const pending = new Map<number, { client: WebSocket; id: number }>();
  const sessionOwners = new Map<string, WebSocket>();
  const clients = new Set<WebSocket>();
  let idleTimer: NodeJS.Timeout | null = null;

  const status = () => ({ state, error: lastError || undefined, source: endpoint?.source, silent: endpoint?.silent });

  function scheduleIdleExit(): void {
    if (idleTimer) clearTimeout(idleTimer);
    // Without a browser connection there is nothing worth keeping alive for.
    if (state !== 'connected' && clients.size === 0) idleTimer = setTimeout(() => shutdown('idle'), 60_000);
  }

  function shutdown(reason: string): void {
    blog('exiting:', reason);
    try {
      const info = readBrokerInfo();
      if (info?.pid === process.pid) rmSync(brokerInfoFile(), { force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  }

  async function tryEndpoint(ep: Endpoint): Promise<WebSocket> {
    let wsUrl = ep.wsUrl;
    if (wsUrl.startsWith('http')) {
      const res = await fetch(new URL('/json/version', wsUrl));
      wsUrl = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    }
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      // Consent prompts keep the handshake (or first reply) pending until the user answers.
      const timer = setTimeout(() => reject(new Error('timed out waiting for the browser (was the "Allow remote debugging" prompt answered?)')), 90_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`browser refused the connection (HTTP ${res.statusCode})`));
      });
    });
    // Make sure this is the browser that runs our extension.
    const targets = await new Promise<Array<{ type: string; url: string }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser did not answer (consent prompt pending or denied)')), 90_000);
      ws.on('message', function onMsg(data) {
        const msg = JSON.parse(String(data)) as CdpMessage;
        if (msg.id === 0) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve((msg.result as { targetInfos: Array<{ type: string; url: string }> }).targetInfos);
        }
      });
      ws.send(JSON.stringify({ id: 0, method: 'Target.getTargets', params: {} }));
    });
    if (!targets.some((t) => t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`))) {
      ws.close();
      throw new Error('that browser does not run the Kyte WebMCP extension');
    }
    return ws;
  }

  function connectBrowser(hints: EndpointHints): Promise<void> {
    if (state === 'connected') return Promise.resolve();
    if (connecting) return connecting;
    connecting = (async () => {
      state = 'connecting';
      lastError = '';
      const candidates = discoverEndpoints(hints);
      if (!candidates.length) {
        state = 'failed';
        lastError = 'no browser with remote debugging enabled was found';
        return;
      }
      const errors: string[] = [];
      for (const ep of candidates) {
        try {
          const ws = await tryEndpoint(ep);
          browser = ws;
          endpoint = ep;
          state = 'connected';
          blog('connected to', ep.source);
          ws.on('message', (data) => onBrowserMessage(String(data)));
          ws.on('close', () => {
            for (const c of clients) c.send(JSON.stringify({ method: 'Broker.disconnected', params: {} }));
            shutdown('browser connection closed');
          });
          return;
        } catch (e) {
          errors.push(`${ep.source}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      state = 'failed';
      lastError = errors.join('; ');
    })().finally(() => {
      connecting = null;
      scheduleIdleExit();
    });
    return connecting;
  }

  function onBrowserMessage(raw: string): void {
    const msg = JSON.parse(raw) as CdpMessage;
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      const result = msg.result as { sessionId?: string } | undefined;
      if (result?.sessionId) sessionOwners.set(result.sessionId, p.client);
      if (p.client.readyState === WebSocket.OPEN) p.client.send(JSON.stringify({ ...msg, id: p.id }));
      return;
    }
    if (msg.method === 'Target.detachedFromTarget') sessionOwners.delete(String(msg.params?.sessionId));
    const owner = msg.sessionId ? sessionOwners.get(msg.sessionId) : undefined;
    if (owner) {
      if (owner.readyState === WebSocket.OPEN) owner.send(raw);
    } else if (!msg.sessionId) {
      for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(raw);
    }
  }

  async function onClientMessage(client: WebSocket, raw: string): Promise<void> {
    const msg = JSON.parse(raw) as CdpMessage;
    if (msg.id === undefined || !msg.method) return;
    if (msg.method === 'Broker.status') {
      client.send(JSON.stringify({ id: msg.id, result: status() }));
      return;
    }
    if (msg.method === 'Broker.connect') {
      const { endpoint, userDataDir } = (msg.params ?? {}) as EndpointHints;
      await connectBrowser({ endpoint, userDataDir });
      client.send(JSON.stringify({ id: msg.id, result: status() }));
      return;
    }
    if (state !== 'connected' || !browser) {
      client.send(JSON.stringify({ id: msg.id, error: { message: 'full DevTools channel is not connected' } }));
      return;
    }
    const browserId = nextBrowserId++;
    pending.set(browserId, { client, id: msg.id });
    browser.send(JSON.stringify({ id: browserId, method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId }));
  }

  const server = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({
    server,
    path: BROKER_PATH,
    maxPayload: 512 * 1024 * 1024,
    verifyClient: (info: { req: IncomingMessage }) => info.req.headers.authorization === `Bearer ${token}`,
  });
  wss.on('connection', (client) => {
    clients.add(client);
    if (idleTimer) clearTimeout(idleTimer);
    client.on('message', (data) => void onClientMessage(client, String(data)).catch((e) => blog('client message failed', e)));
    client.on('close', () => {
      clients.delete(client);
      for (const [sessionId, owner] of sessionOwners) {
        if (owner === client) {
          sessionOwners.delete(sessionId);
          browser?.send(JSON.stringify({ id: nextBrowserId++, method: 'Target.detachFromTarget', params: { sessionId } }));
        }
      }
      scheduleIdleExit();
    });
  });

  let port = 0;
  for (let p = BROKER_PORT_BASE; p < BROKER_PORT_BASE + BROKER_PORT_COUNT && !port; p++) {
    port = await new Promise<number>((resolve) => {
      server.once('error', () => resolve(0));
      server.listen(p, '127.0.0.1', () => resolve(p));
    });
  }
  if (!port) {
    blog('no free broker port');
    process.exit(1);
  }
  mkdirSync(path.dirname(brokerInfoFile()), { recursive: true });
  writeFileSync(brokerInfoFile(), JSON.stringify({ pid: process.pid, port, token } satisfies BrokerInfo), { mode: 0o600 });
  blog(`listening on 127.0.0.1:${port}`);
  scheduleIdleExit();
}

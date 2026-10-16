import { PORT_BASE, PORT_COUNT, PROTOCOL_VERSION, WS_PATH } from '../../shared/constants.ts';
import { CLOSE_BUSY, type BridgeToExt, type ExtToBridge } from '../../shared/protocol.ts';
import type { Core } from './core.ts';
import { Session } from './sessions.ts';

interface Socket {
  ws: WebSocket;
  opened: boolean;
  session: Session | null;
}

/**
 * Finds bridges on the loopback port range and keeps one WebSocket per
 * bridge. WebSocket traffic (a ping every 20 s) also keeps the MV3 service
 * worker alive while a client is connected.
 */
export class Connections {
  readonly #core: Core;
  readonly #sockets = new Map<number, Socket>();
  readonly #retryAt = new Map<number, number>();
  readonly #failures = new Map<number, number>();
  #sessionIndex = 0;
  #started = false;

  constructor(core: Core) {
    this.#core = core;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.scan();
    setInterval(() => this.scan(), 2000);
    setInterval(() => {
      for (const s of this.#sockets.values()) if (s.opened) this.#send(s, { t: 'ping' });
    }, 20_000);
  }

  connectedCount(): number {
    return [...this.#sockets.values()].filter((s) => s.session).length;
  }

  scan(): void {
    const now = Date.now();
    for (let port = PORT_BASE; port < PORT_BASE + PORT_COUNT; port++) {
      if (this.#sockets.has(port)) continue;
      if ((this.#retryAt.get(port) ?? 0) > now) continue;
      this.#connect(port);
    }
  }

  #send(socket: Socket, msg: ExtToBridge): void {
    if (socket.ws.readyState === WebSocket.OPEN) socket.ws.send(JSON.stringify(msg));
  }

  #connect(port: number): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    } catch {
      return;
    }
    const socket: Socket = { ws, opened: false, session: null };
    this.#sockets.set(port, socket);
    ws.onopen = () => {
      socket.opened = true;
      this.#failures.delete(port);
      this.#send(socket, { t: 'hello', protocol: PROTOCOL_VERSION, extVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
    };
    ws.onmessage = (event) => this.#onMessage(socket, port, String(event.data));
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (event) => {
      this.#sockets.delete(port);
      if (socket.session) {
        const session = socket.session;
        socket.session = null;
        void this.#core.endSession(session, 'the MCP client disconnected');
      }
      let delay: number;
      if (event.code === CLOSE_BUSY) delay = 30_000;
      else if (!socket.opened) {
        const n = (this.#failures.get(port) ?? 0) + 1;
        this.#failures.set(port, n);
        delay = Math.min(10_000, 1000 * n);
      } else delay = 500;
      this.#retryAt.set(port, Date.now() + delay);
    };
  }

  #onMessage(socket: Socket, port: number, raw: string): void {
    let msg: BridgeToExt;
    try {
      msg = JSON.parse(raw) as BridgeToExt;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome': {
        const session = new Session(port, this.#sessionIndex++, (m) => this.#send(socket, m));
        session.client = msg.client;
        session.bridgeVersion = msg.bridgeVersion;
        // Remembered so the side panel can show the exact command for adding more MCP clients.
        if (msg.cliPath) void chrome.storage.local.set({ bridgeCliPath: msg.cliPath });
        socket.session = session;
        this.#core.startSession(session);
        break;
      }
      case 'client':
        if (socket.session) {
          socket.session.client = msg.client;
          this.#core.sessionsChanged();
        }
        break;
      case 'call':
        if (socket.session) void this.#core.dispatcher.handle(socket.session, msg.id, msg.tool, msg.args);
        break;
      case 'cancel':
        socket.session?.inflight.get(msg.id)?.abort();
        break;
      case 'svc_result':
        socket.session?.resolveService(msg.id, msg.ok, msg.ok ? msg.value : undefined, msg.ok ? undefined : msg.error);
        break;
      case 'pong':
        break;
    }
  }
}

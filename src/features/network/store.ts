/** Per-tab request log built from Network.* events, like the DevTools Network panel. */

export interface WsFrame {
  dir: 'sent' | 'received' | 'event';
  at: number;
  opcode?: number;
  data: string;
}

export interface NetRequest {
  id: string;
  key: string;
  requestId: string;
  sessionId?: string;
  navIndex: number;
  url: string;
  method: string;
  type: string;
  priority?: string;
  frameId?: string;
  wallTime: number;
  startTs: number;
  requestHeaders: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  protocol?: string;
  remoteAddress?: string;
  security?: { protocol: string; cipher: string; subjectName: string; issuer: string; validFrom: number; validTo: number; sanList?: string[] };
  timing?: Record<string, number>;
  fromCache?: boolean;
  fromServiceWorker?: boolean;
  endTs?: number;
  encodedLength?: number;
  failed?: { errorText: string; canceled?: boolean; blockedReason?: string; corsError?: string };
  initiator?: { type: string; url?: string; line?: number; stack?: string[] };
  redirects: Array<{ url: string; status: number }>;
  frames?: WsFrame[];
}

export const MAX_REQUESTS = 1000;
const MAX_FRAMES = 100;

function headersToRecord(h: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

function initiatorOf(init: any): NetRequest['initiator'] {
  if (!init) return undefined;
  const frames: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }> = init.stack?.callFrames ?? init.stack?.parent?.callFrames ?? [];
  const top = frames[0];
  return {
    type: init.type,
    url: init.url ?? top?.url,
    line: init.lineNumber !== undefined ? init.lineNumber + 1 : top ? top.lineNumber + 1 : undefined,
    stack: frames.slice(0, 5).map((f) => `at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`),
  };
}

export class NetworkStore {
  readonly #tabs = new Map<number, { list: NetRequest[]; byKey: Map<string, NetRequest>; next: number; navIndex: number; extra: Map<string, any>; mainFrameId?: string }>();

  tab(tabId: number) {
    let t = this.#tabs.get(tabId);
    if (!t) this.#tabs.set(tabId, (t = { list: [], byKey: new Map(), next: 1, navIndex: 0, extra: new Map() }));
    return t;
  }

  clear(tabId: number): void {
    const t = this.tab(tabId);
    t.list = [];
    t.byKey.clear();
  }

  drop(tabId: number): void {
    this.#tabs.delete(tabId);
  }

  list(tabId: number): NetRequest[] {
    return this.tab(tabId).list;
  }

  currentNav(tabId: number): number {
    return this.tab(tabId).navIndex;
  }

  get(tabId: number, id: string): NetRequest | undefined {
    return this.tab(tabId).list.find((r) => r.id === id);
  }

  #add(tabId: number, req: Omit<NetRequest, 'id' | 'navIndex'>): NetRequest {
    const t = this.tab(tabId);
    const full: NetRequest = { ...req, id: `r${t.next++}`, navIndex: t.navIndex };
    t.list.push(full);
    t.byKey.set(full.key, full);
    if (t.list.length > MAX_REQUESTS) {
      for (const old of t.list.splice(0, t.list.length - MAX_REQUESTS)) t.byKey.delete(old.key);
    }
    return full;
  }

  onEvent(tabId: number, sessionId: string | undefined, method: string, p: any): void {
    const t = this.tab(tabId);
    const key = `${sessionId ?? ''}:${p.requestId}`;
    const req = t.byKey.get(key);
    switch (method) {
      case 'Page.frameNavigated':
        if (!sessionId && !p.frame.parentId) {
          t.mainFrameId = p.frame.id;
          // The main-document request was already counted for this navigation.
          const doc = t.list.findLast((r) => r.type === 'Document' && r.frameId === p.frame.id && !r.sessionId);
          t.navIndex = doc && doc.navIndex > t.navIndex ? doc.navIndex : t.navIndex + 1;
        }
        break;
      case 'Network.requestWillBeSent': {
        if (req && p.redirectResponse) {
          req.redirects.push({ url: req.url, status: p.redirectResponse.status });
          req.url = p.request.url;
          req.method = p.request.method;
          req.requestHeaders = headersToRecord(p.request.headers);
          return;
        }
        const created = this.#add(tabId, {
          key,
          requestId: p.requestId,
          sessionId,
          url: p.request.url,
          method: p.request.method,
          type: p.type ?? 'Other',
          priority: p.request.initialPriority,
          frameId: p.frameId,
          wallTime: Math.round((p.wallTime ?? Date.now() / 1000) * 1000),
          startTs: p.timestamp,
          requestHeaders: headersToRecord(p.request.headers),
          postData: p.request.postData,
          hasPostData: p.request.hasPostData,
          initiator: initiatorOf(p.initiator),
          redirects: [],
        });
        // Main-document requests belong to the navigation they start.
        if (p.type === 'Document' && !sessionId && p.requestId === p.loaderId && (!t.mainFrameId || p.frameId === t.mainFrameId)) created.navIndex = t.navIndex + 1;
        const extra = t.extra.get(key);
        if (extra) {
          Object.assign(created.requestHeaders, headersToRecord(extra.headers));
          t.extra.delete(key);
        }
        break;
      }
      case 'Network.requestWillBeSentExtraInfo':
        if (req) Object.assign(req.requestHeaders, headersToRecord(p.headers));
        else {
          t.extra.set(key, p);
          if (t.extra.size > 200) t.extra.delete(t.extra.keys().next().value!);
        }
        break;
      case 'Network.responseReceived': {
        if (!req) return;
        const r = p.response;
        req.status = r.status;
        req.statusText = r.statusText;
        req.mimeType = r.mimeType;
        req.responseHeaders = { ...headersToRecord(r.headers), ...(req.responseHeaders ?? {}) };
        req.protocol = r.protocol;
        req.remoteAddress = r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : undefined;
        req.timing = r.timing;
        req.fromCache = req.fromCache || r.fromDiskCache || r.fromPrefetchCache;
        req.fromServiceWorker = r.fromServiceWorker;
        if (p.type) req.type = p.type;
        if (r.securityDetails) {
          const s = r.securityDetails;
          req.security = { protocol: s.protocol, cipher: s.cipher, subjectName: s.subjectName, issuer: s.issuer, validFrom: s.validFrom, validTo: s.validTo, sanList: s.sanList };
        }
        break;
      }
      case 'Network.responseReceivedExtraInfo':
        if (req) req.responseHeaders = { ...(req.responseHeaders ?? {}), ...headersToRecord(p.headers) };
        break;
      case 'Network.requestServedFromCache':
        if (req) req.fromCache = true;
        break;
      case 'Network.loadingFinished':
        if (req) {
          req.endTs = p.timestamp;
          req.encodedLength = p.encodedDataLength;
        }
        break;
      case 'Network.loadingFailed':
        if (req) {
          req.endTs = p.timestamp;
          req.failed = { errorText: p.errorText, canceled: p.canceled, blockedReason: p.blockedReason, corsError: p.corsErrorStatus?.corsError };
        }
        break;
      case 'Network.webSocketCreated':
        this.#add(tabId, { key, requestId: p.requestId, sessionId, url: p.url, method: 'GET', type: 'WebSocket', wallTime: Date.now(), startTs: 0, requestHeaders: {}, initiator: initiatorOf(p.initiator), redirects: [], frames: [] });
        break;
      case 'Network.webSocketHandshakeResponseReceived':
        if (req) {
          req.status = p.response.status;
          req.statusText = p.response.statusText;
          req.responseHeaders = headersToRecord(p.response.headers);
        }
        break;
      case 'Network.webSocketWillSendHandshakeRequest':
        if (req) req.requestHeaders = headersToRecord(p.request.headers);
        break;
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived':
      case 'Network.eventSourceMessageReceived': {
        if (!req) return;
        req.frames ??= [];
        const data = method === 'Network.eventSourceMessageReceived' ? `${p.eventName}: ${p.data}` : String(p.response.payloadData ?? '');
        req.frames.push({ dir: method.endsWith('Sent') ? 'sent' : method.endsWith('Received') && method.includes('Frame') ? 'received' : 'event', at: Date.now(), opcode: p.response?.opcode, data: data.length > 2000 ? `${data.slice(0, 2000)}…` : data });
        if (req.frames.length > MAX_FRAMES) req.frames.shift();
        break;
      }
      case 'Network.webSocketClosed':
        if (req) req.endTs = p.timestamp;
        break;
    }
  }
}

export function durationMs(r: NetRequest): number | undefined {
  if (!r.endTs || !r.startTs) return undefined;
  return Math.round((r.endTs - r.startTs) * 1000);
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

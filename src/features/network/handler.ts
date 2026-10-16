import type { Core } from '../../extension/background/core.ts';
import type { Feature } from '../../extension/background/types.ts';
import { ToolError, formatBytes, toBase64, truncate } from '../../extension/background/util.ts';
import { NetworkStore, durationMs, globToRegExp, type NetRequest } from './store.ts';

const store = new NetworkStore();

interface MockRule {
  id: string;
  sessionId: string;
  pattern: string;
  regex: RegExp;
  resourceType?: string;
  method?: string;
  action: 'block' | 'respond' | 'headers';
  status?: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  setHeaders?: Record<string, string>;
  hits: number;
}

const rules = new Map<number, MockRule[]>();
let nextRuleId = 1;

function matchesStatus(r: NetRequest, filter: string): boolean {
  if (filter === 'failed') return !!r.failed || (r.status ?? 0) >= 400;
  if (/^\dxx$/i.test(filter)) return r.status !== undefined && Math.floor(r.status / 100) === Number(filter[0]);
  return String(r.status) === filter;
}

function summaryLine(r: NetRequest): string {
  const dur = durationMs(r);
  const size = r.encodedLength !== undefined ? formatBytes(r.encodedLength) : '';
  const status = r.failed ? `FAILED ${r.failed.errorText}${r.failed.blockedReason ? ` (${r.failed.blockedReason})` : ''}${r.failed.corsError ? ` (CORS ${r.failed.corsError})` : ''}` : r.status !== undefined ? String(r.status) : 'pending';
  const cache = r.fromCache ? ' (cache)' : r.fromServiceWorker ? ' (service worker)' : '';
  const init = r.initiator?.url ? ` ← ${r.initiator.type} ${r.initiator.url.split('/').pop()}${r.initiator.line ? `:${r.initiator.line}` : ''}` : r.initiator ? ` ← ${r.initiator.type}` : '';
  const url = r.url.length > 160 ? `${r.url.slice(0, 159)}…` : r.url;
  return `${r.id} ${r.method} ${status} ${r.type}${r.mimeType ? ` ${r.mimeType}` : ''}${size ? ` ${size}` : ''}${dur !== undefined ? ` ${dur} ms` : ''}${cache} ${url}${init}${r.redirects.length ? ` (after ${r.redirects.length} redirect${r.redirects.length > 1 ? 's' : ''})` : ''}`;
}

function timingBreakdown(r: NetRequest): string | undefined {
  const t = r.timing;
  if (!t) return undefined;
  const span = (a: number, b: number) => (a >= 0 && b >= 0 ? Math.round((b - a) * 10) / 10 : undefined);
  const parts = [
    ['dns', span(t.dnsStart!, t.dnsEnd!)],
    ['connect', span(t.connectStart!, t.connectEnd!)],
    ['ssl', span(t.sslStart!, t.sslEnd!)],
    ['send', span(t.sendStart!, t.sendEnd!)],
    ['wait (TTFB)', span(t.sendEnd!, t.receiveHeadersEnd!)],
  ].filter(([, v]) => v !== undefined && (v as number) > 0);
  const total = durationMs(r);
  const download = total !== undefined && t.receiveHeadersEnd ? Math.max(0, Math.round(total - t.receiveHeadersEnd)) : undefined;
  return `total ${total ?? '?'} ms (${parts.map(([k, v]) => `${k} ${v}`).join(', ')}${download !== undefined ? `, download ${download}` : ''})`;
}

function isTextual(mime: string | undefined): boolean {
  if (!mime) return true;
  return /^text\/|json|javascript|xml|html|css|svg|x-www-form-urlencoded|graphql|csv|yaml|vtt/i.test(mime);
}

async function responseBody(core: Core, tabId: number, r: NetRequest): Promise<{ body: string; base64: boolean } | null> {
  try {
    const res = await core.cdp.send(tabId, 'Network.getResponseBody', { requestId: r.requestId }, r.sessionId);
    return { body: res.body, base64: res.base64Encoded };
  } catch {
    return null;
  }
}

async function postData(core: Core, tabId: number, r: NetRequest): Promise<string | undefined> {
  if (r.postData !== undefined) return r.postData;
  if (!r.hasPostData) return undefined;
  try {
    return (await core.cdp.send(tabId, 'Network.getRequestPostData', { requestId: r.requestId }, r.sessionId)).postData;
  } catch {
    return undefined;
  }
}

function headerLines(h: Record<string, string> | undefined): string {
  if (!h || !Object.keys(h).length) return '  (none)';
  return Object.entries(h)
    .map(([k, v]) => `  ${k}: ${v.length > 400 ? `${v.slice(0, 400)}…` : v}`)
    .join('\n');
}

function harTimings(r: NetRequest): Record<string, number> {
  const t = r.timing;
  const total = durationMs(r) ?? -1;
  if (!t) return { blocked: -1, dns: -1, connect: -1, send: 0, wait: total, receive: 0, ssl: -1 };
  const span = (a: number, b: number) => (a >= 0 && b >= 0 ? Math.max(0, b - a) : -1);
  const wait = span(t.sendEnd!, t.receiveHeadersEnd!);
  return {
    blocked: t.dnsStart! > 0 ? t.dnsStart! : -1,
    dns: span(t.dnsStart!, t.dnsEnd!),
    connect: span(t.connectStart!, t.connectEnd!),
    ssl: span(t.sslStart!, t.sslEnd!),
    send: Math.max(0, span(t.sendStart!, t.sendEnd!)),
    wait: Math.max(0, wait),
    receive: total >= 0 && t.receiveHeadersEnd ? Math.max(0, total - t.receiveHeadersEnd) : 0,
  };
}

async function applyRules(core: Core, tabId: number): Promise<void> {
  const list = rules.get(tabId) ?? [];
  const sessions: Array<string | undefined> = [undefined, ...core.cdp.children(tabId).filter((c) => c.type === 'iframe').map((c) => c.sessionId)];
  for (const s of sessions) {
    if (list.length) {
      await core.cdp
        .send(tabId, 'Fetch.enable', { patterns: list.map((r) => ({ urlPattern: r.pattern, ...(r.resourceType ? { resourceType: r.resourceType } : {}), requestStage: 'Request' })) }, s)
        .catch(() => {});
    } else {
      await core.cdp.send(tabId, 'Fetch.disable', {}, s).catch(() => {});
    }
  }
}

export const networkFeature: Feature = {
  name: 'network',
  setup(core) {
    core.cdp.on((tabId, sessionId, method, params) => {
      if (method.startsWith('Network.') || method === 'Page.frameNavigated') store.onEvent(tabId, sessionId, method, params);
      if (method === 'Fetch.requestPaused') {
        const list = rules.get(tabId) ?? [];
        const url: string = params.request.url;
        const rule = list.find((r) => r.regex.test(url) && (!r.method || r.method.toUpperCase() === params.request.method) && (!r.resourceType || r.resourceType === params.resourceType));
        const id = params.requestId;
        const send = (m: string, p: Record<string, unknown>) => core.cdp.send(tabId, m, p, sessionId).catch(() => {});
        if (!rule) {
          void send('Fetch.continueRequest', { requestId: id });
          return;
        }
        rule.hits++;
        if (rule.action === 'block') void send('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' });
        else if (rule.action === 'respond') {
          const headers = Object.entries(rule.headers ?? { 'content-type': 'text/plain' }).map(([name, value]) => ({ name, value }));
          void send('Fetch.fulfillRequest', { requestId: id, responseCode: rule.status ?? 200, responseHeaders: headers, body: rule.bodyBase64 ?? '' });
        } else {
          const merged: Record<string, string> = { ...(params.request.headers ?? {}) };
          for (const [k, v] of Object.entries(rule.setHeaders ?? {})) merged[k] = v;
          void send('Fetch.continueRequest', { requestId: id, headers: Object.entries(merged).map(([name, value]) => ({ name, value: String(value) })) });
        }
      }
    });
    // Child frames attached later must see the same interception rules.
    core.cdp.onAttach(async (tabId, sessionId, type) => {
      if (sessionId && type === 'iframe' && rules.get(tabId)?.length) await applyRules(core, tabId);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      store.drop(tabId);
      rules.delete(tabId);
    });
    core.onSessionEnd(async (session) => {
      for (const [tabId, list] of rules) {
        const kept = list.filter((r) => r.sessionId !== session.id);
        if (kept.length !== list.length) {
          rules.set(tabId, kept);
          await applyRules(core, tabId);
        }
      }
    });
  },
  handlers: {
    async network_requests(args: { urlPattern?: string; types?: string[]; method?: string; status?: string; limit?: number; all?: boolean; clear?: boolean }, { core, tabId }) {
      await core.cdp.ensure(tabId);
      let list = store.list(tabId);
      const total = list.length;
      if (!args.all) {
        const nav = store.currentNav(tabId);
        list = list.filter((r) => r.navIndex >= nav);
      }
      if (args.urlPattern) {
        const m = args.urlPattern.match(/^\/(.+)\/([a-z]*)$/);
        const re = m ? new RegExp(m[1]!, m[2] || 'i') : null;
        list = list.filter((r) => (re ? re.test(r.url) : r.url.toLowerCase().includes(args.urlPattern!.toLowerCase())));
      }
      if (args.types?.length) list = list.filter((r) => args.types!.includes(r.type));
      if (args.method) list = list.filter((r) => r.method.toUpperCase() === args.method!.toUpperCase());
      if (args.status) list = list.filter((r) => matchesStatus(r, args.status!));
      const shown = list.slice(-(args.limit ?? 100));
      if (args.clear) store.clear(tabId);
      if (!shown.length) return `No requests${total ? ` match (buffer holds ${total}; set all=true to include earlier pages)` : ' captured yet. Requests are recorded from the moment the agent first touches the tab; reload with navigate(action="reload") to capture the page load'}.`;
      return `${shown.length} of ${list.length} requests${args.all ? '' : ' since the last navigation'}:\n${shown.map(summaryLine).join('\n')}`;
    },

    async network_request(args: { id: string; body?: boolean; maxBodyChars?: number; savePath?: string }, { core, tabId, session }) {
      await core.cdp.ensure(tabId);
      const r = store.get(tabId, args.id);
      if (!r) throw new ToolError(`Unknown request id ${args.id}. Use network_requests to list ids.`);
      const lines = [`${r.id} ${r.method} ${r.url}`];
      lines.push(`Status: ${r.failed ? `FAILED ${r.failed.errorText}` : `${r.status ?? 'pending'} ${r.statusText ?? ''}`} · ${r.type}${r.mimeType ? ` · ${r.mimeType}` : ''}${r.protocol ? ` · ${r.protocol}` : ''}${r.remoteAddress ? ` · ${r.remoteAddress}` : ''}${r.fromCache ? ' · from cache' : ''}${r.fromServiceWorker ? ' · from service worker' : ''}${r.priority ? ` · priority ${r.priority}` : ''}`);
      if (r.failed?.blockedReason || r.failed?.corsError) lines.push(`Blocked: ${r.failed.blockedReason ?? ''} ${r.failed.corsError ? `CORS ${r.failed.corsError}` : ''}`);
      if (r.redirects.length) lines.push(`Redirects: ${r.redirects.map((x) => `${x.status} ${x.url}`).join(' → ')}`);
      const timing = timingBreakdown(r);
      if (timing) lines.push(`Timing: ${timing}`);
      if (r.encodedLength !== undefined) lines.push(`Transferred: ${formatBytes(r.encodedLength)}`);
      if (r.initiator) lines.push(`Initiator: ${r.initiator.type}${r.initiator.url ? ` ${r.initiator.url}${r.initiator.line ? `:${r.initiator.line}` : ''}` : ''}${r.initiator.stack?.length ? `\n  ${r.initiator.stack.join('\n  ')}` : ''}`);
      if (r.security) lines.push(`Security: ${r.security.protocol} ${r.security.cipher} · certificate "${r.security.subjectName}" by ${r.security.issuer}, valid ${new Date(r.security.validFrom * 1000).toISOString().slice(0, 10)} → ${new Date(r.security.validTo * 1000).toISOString().slice(0, 10)}`);
      lines.push(`Request headers:\n${headerLines(r.requestHeaders)}`);
      const post = await postData(core, tabId, r);
      if (post !== undefined) lines.push(`Request body:\n${truncate(post, 10_000)}`);
      if (r.responseHeaders) lines.push(`Response headers:\n${headerLines(r.responseHeaders)}`);
      if (r.frames?.length) lines.push(`Messages (last ${r.frames.length}):\n${r.frames.map((f) => `  ${f.dir === 'sent' ? '→' : f.dir === 'received' ? '←' : '•'} ${new Date(f.at).toISOString().slice(11, 23)} ${f.data}`).join('\n')}`);
      if (args.body !== false && r.type !== 'WebSocket') {
        const body = await responseBody(core, tabId, r);
        if (!body) lines.push('Response body: not available (still loading, evicted from the buffer, or no body).');
        else {
          const text = body.base64 && isTextual(r.mimeType) ? new TextDecoder().decode(Uint8Array.from(atob(body.body), (c) => c.charCodeAt(0))) : body.base64 ? null : body.body;
          if (args.savePath || text === null || (text && text.length > (args.maxBodyChars ?? 20_000) * 5)) {
            const ext = (r.mimeType?.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
            const saved = await session.writeFile({ path: args.savePath, stem: `response-${r.id}`, ext, data: text === null ? body.body : text, encoding: text === null ? 'base64' : 'utf8' });
            lines.push(`Response body saved to ${saved.path} (${formatBytes(saved.bytes)}).`);
          } else lines.push(`Response body:\n${truncate(text ?? '', args.maxBodyChars ?? 20_000, `pass savePath to get all of it`)}`);
        }
      }
      return lines.join('\n');
    },

    async network_har(args: { savePath?: string; bodies?: boolean }, { core, tabId, session }) {
      await core.cdp.ensure(tabId);
      const tab = await chrome.tabs.get(tabId);
      const list = store.list(tabId).filter((r) => r.type !== 'WebSocket' || r.status);
      const entries = [];
      for (const r of list) {
        let content: Record<string, unknown> = { size: r.encodedLength ?? 0, mimeType: r.mimeType ?? 'x-unknown' };
        if (args.bodies) {
          const b = await responseBody(core, tabId, r);
          if (b) content = { ...content, text: b.body, ...(b.base64 ? { encoding: 'base64' } : {}) };
        }
        const post = await postData(core, tabId, r);
        const url = new URL(r.url);
        entries.push({
          pageref: 'page_1',
          startedDateTime: new Date(r.wallTime).toISOString(),
          time: durationMs(r) ?? -1,
          request: {
            method: r.method,
            url: r.url,
            httpVersion: r.protocol ?? 'HTTP/1.1',
            cookies: [],
            headers: Object.entries(r.requestHeaders).map(([name, value]) => ({ name, value })),
            queryString: [...url.searchParams.entries()].map(([name, value]) => ({ name, value })),
            ...(post !== undefined ? { postData: { mimeType: r.requestHeaders['content-type'] ?? '', text: post } } : {}),
            headersSize: -1,
            bodySize: post?.length ?? 0,
          },
          response: {
            status: r.status ?? 0,
            statusText: r.failed?.errorText ?? r.statusText ?? '',
            httpVersion: r.protocol ?? 'HTTP/1.1',
            cookies: [],
            headers: Object.entries(r.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
            content,
            redirectURL: r.responseHeaders?.location ?? '',
            headersSize: -1,
            bodySize: r.encodedLength ?? -1,
            ...(r.failed ? { _error: r.failed.errorText } : {}),
          },
          cache: {},
          timings: harTimings(r),
          serverIPAddress: r.remoteAddress?.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') ?? '',
          _resourceType: r.type.toLowerCase(),
          _initiator: r.initiator,
        });
      }
      const har = {
        log: {
          version: '1.2',
          creator: { name: 'Neo WebMCP', version: chrome.runtime.getManifest().version },
          pages: [{ startedDateTime: entries[0]?.startedDateTime ?? new Date().toISOString(), id: 'page_1', title: tab.title ?? tab.url ?? '', pageTimings: {} }],
          entries,
        },
      };
      const json = JSON.stringify(har);
      const saved = await session.streamFile({ path: args.savePath, stem: 'network', ext: 'har' }, async (write) => {
        for (let i = 0; i < json.length; i += 1_000_000) await write(json.slice(i, i + 1_000_000), 'utf8');
      });
      return `Saved ${entries.length} requests as HAR to ${saved.path} (${formatBytes(saved.bytes)})${args.bodies ? ' with response bodies' : ''}.`;
    },

    async network_mock(args: { action: 'add' | 'list' | 'remove' | 'clear'; urlPattern?: string; resourceType?: string; method?: string; respond?: { status?: number; headers?: Record<string, string>; body?: string; bodyBase64?: string }; block?: boolean; setHeaders?: Record<string, string>; id?: string }, { core, tabId, session }) {
      await core.cdp.ensure(tabId);
      const list = rules.get(tabId) ?? [];
      if (args.action === 'list') {
        if (!list.length) return 'No interception rules on this tab.';
        return list.map((r) => `${r.id} ${r.action} ${r.method ?? '*'} ${r.pattern}${r.resourceType ? ` [${r.resourceType}]` : ''}${r.status ? ` → ${r.status}` : ''} · ${r.hits} hit${r.hits === 1 ? '' : 's'}`).join('\n');
      }
      if (args.action === 'clear') {
        rules.set(tabId, []);
        await applyRules(core, tabId);
        return `Removed ${list.length} rule${list.length === 1 ? '' : 's'}.`;
      }
      if (args.action === 'remove') {
        if (!args.id) throw new ToolError('Give the rule id to remove.');
        const kept = list.filter((r) => r.id !== args.id);
        if (kept.length === list.length) throw new ToolError(`No rule ${args.id}.`);
        rules.set(tabId, kept);
        await applyRules(core, tabId);
        return `Removed rule ${args.id}.`;
      }
      if (!args.urlPattern) throw new ToolError('urlPattern is required to add a rule.');
      const action: MockRule['action'] = args.block ? 'block' : args.respond ? 'respond' : args.setHeaders ? 'headers' : 'block';
      const body = args.respond?.bodyBase64 ?? (args.respond?.body !== undefined ? toBase64(new TextEncoder().encode(args.respond.body)) : undefined);
      const rule: MockRule = {
        id: `m${nextRuleId++}`,
        sessionId: session.id,
        pattern: args.urlPattern,
        regex: globToRegExp(args.urlPattern),
        resourceType: args.resourceType,
        method: args.method,
        action,
        status: args.respond?.status,
        headers: args.respond?.headers,
        bodyBase64: body,
        setHeaders: args.setHeaders,
        hits: 0,
      };
      rules.set(tabId, [...list, rule]);
      await applyRules(core, tabId);
      return `Added rule ${rule.id}: ${action}${action === 'respond' ? ` with HTTP ${rule.status ?? 200}` : ''} for ${rule.method ?? 'any method'} ${rule.pattern}. It stays until removed or the session ends.`;
    },
  },
};

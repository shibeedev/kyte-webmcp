/** DevTools data through the extension: network (+HAR, mocks), performance, coverage, elements, application, emulation, issues, memory, raw CDP. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { call, launchBrowser, ok, refOf, sleep, startClient, waitConnected, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';

const PORT = 17838;
let srv: FixtureServers;
let bh: BrowserHandle;
let mcp: McpHandle;

const savedPath = (text: string, ext: string) => {
  const m = text.match(new RegExp(`([A-Za-z]:[\\\\/][^\\s]+\\.${ext}|/[^\\s]+\\.${ext})`));
  assert.ok(m, `no .${ext} path in: ${text}`);
  return m[1]!;
};

describe('devtools data', () => {
  before(async () => {
    srv = await startFixtureServers();
    bh = await launchBrowser();
    mcp = await startClient(PORT);
    await waitConnected(mcp.client);
    await ok(mcp.client, 'tab_open', { url: `${srv.a}/index.html` });
  });
  after(async () => {
    await mcp?.close();
    await bh?.close();
    await srv?.close();
  });

  it('lists and inspects network requests', async () => {
    await ok(mcp.client, 'navigate', { action: 'reload' });
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Call API"/) });
    await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Fail API"/) });
    await sleep(500);
    const list = await ok(mcp.client, 'network_requests');
    assert.match(list.text, /r\d+ GET 200 Document text\/html .*index\.html/);
    assert.match(list.text, /r\d+ POST 200 Fetch application\/json .*\/api\/echo/);
    const failed = await ok(mcp.client, 'network_requests', { status: '5xx' });
    assert.match(failed.text, /500 Fetch .*\/api\/error/);
    assert.doesNotMatch(failed.text, /api\/echo/);
    const id = list.text.match(/(r\d+) POST 200 Fetch/)![1]!;
    const detail = await ok(mcp.client, 'network_request', { id });
    assert.match(detail.text, /Request body:\n\{"hello":"world"\}/);
    assert.match(detail.text, /x-test-header: yes/);
    assert.match(detail.text, /Response body:\n\{"method":"POST"/);
    assert.match(detail.text, /Timing: total \d+ ms/);
    assert.match(detail.text, /Initiator: script/);
  });

  it('captures WebSocket frames', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/storage.html` });
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Open WebSocket"/) });
    await ok(mcp.client, 'wait_for', { text: 'ws:echo:ping from page', timeoutMs: 5000 });
    const list = await ok(mcp.client, 'network_requests', { types: ['WebSocket'] });
    const id = list.text.match(/(r\d+) GET 101 WebSocket/)![1]!;
    const detail = await ok(mcp.client, 'network_request', { id });
    assert.match(detail.text, /→ .*ping from page/);
    assert.match(detail.text, /← .*echo:ping from page/);
  });

  it('exports HAR', async () => {
    const har = await ok(mcp.client, 'network_har', { bodies: true });
    const file = savedPath(har.text, 'har');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(json.log.version, '1.2');
    assert.ok(json.log.entries.length >= 3);
    assert.ok(json.log.entries.some((e: any) => e.request.url.endsWith('/storage.html') && e.response.status === 200));
  });

  it('mocks, blocks and rewrites requests, and removes rules', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/index.html` });
    await ok(mcp.client, 'network_mock', { action: 'add', urlPattern: '*/api/echo', respond: { status: 418, headers: { 'content-type': 'application/json' }, body: '{"mocked":true}' } });
    const r1 = await ok(mcp.client, 'evaluate', { expression: 'fetch("/api/echo").then(r => r.status + ":" + r.headers.get("content-type")).then(s => s)' });
    assert.match(r1.text, /418:application\/json/);
    await ok(mcp.client, 'network_mock', { action: 'add', urlPattern: '*/api/slow*', block: true });
    const r2 = await ok(mcp.client, 'evaluate', { expression: 'fetch("/api/slow?ms=10").then(() => "ok", e => "blocked:" + e.message)' });
    assert.match(r2.text, /blocked:/);
    const listed = await ok(mcp.client, 'network_mock', { action: 'list' });
    assert.match(listed.text, /m\d+ respond .*\/api\/echo .*1 hit/);
    await ok(mcp.client, 'network_mock', { action: 'clear' });
    const r3 = await ok(mcp.client, 'evaluate', { expression: 'fetch("/api/echo").then(r => r.status)' });
    assert.match(r3.text, /200/);
    await ok(mcp.client, 'network_mock', { action: 'add', urlPattern: '*/api/echo', setHeaders: { 'x-injected': 'neo' } });
    const r4 = await ok(mcp.client, 'evaluate', { expression: 'fetch("/api/echo").then(r => r.json()).then(j => j.headers["x-injected"])' });
    assert.match(r4.text, /"neo"/);
    await ok(mcp.client, 'network_mock', { action: 'clear' });
  });

  it('measures web vitals and runtime metrics', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/perf.html` });
    await sleep(800);
    const m = await ok(mcp.client, 'perf_metrics');
    assert.match(m.text, /LCP \d+ ms \((good|needs improvement|poor)\) — <h1#hero>/);
    assert.match(m.text, /CLS 0\.\d+/);
    assert.match(m.text, /TTFB \d+ ms/);
    assert.match(m.text, /DOM nodes \d+/);
  });

  it('records and analyzes a performance trace', async () => {
    const t = await ok(mcp.client, 'perf_trace', { action: 'run', reload: true }, 120_000);
    const file = savedPath(t.text, 'json');
    assert.ok(existsSync(file));
    const trace = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok((trace.traceEvents ?? trace).length > 100);
    assert.match(t.text, /FCP \d+(\.\d)? ms/);
    assert.match(t.text, /LCP \d+(\.\d)? ms/);
    assert.match(t.text, /Long tasks: [1-9]/);
    assert.match(t.text, /Render-blocking requests:\n\s+- .*perf-blocking\.js/);
    assert.match(t.text, /Main thread \(self time\): .*scripting/);
  });

  it('measures CSS coverage (and reports JS coverage availability)', async () => {
    await ok(mcp.client, 'coverage', { action: 'start', reload: true });
    await sleep(1200);
    const c = await ok(mcp.client, 'coverage', { action: 'stop' });
    assert.match(c.text, /CSS .* unused of .*perf\.css/);
    assert.match(c.text, /JavaScript coverage (unavailable|failed)|JS /);
  });

  it('inspects an element like the Elements panel', async () => {
    const found = await ok(mcp.client, 'find', { selector: '#hero' });
    const ref = found.text.match(/\[ref=(e\d+)\]/)![1]!;
    const d = await ok(mcp.client, 'dom_inspect', { ref });
    assert.match(d.text, /Attributes: id="hero"/);
    assert.match(d.text, /HTML:\n<h1 id="hero">/);
    assert.match(d.text, /Box: \d+×\d+/);
    assert.match(d.text, /font-size: 40px/);
    assert.match(d.text, /#hero \{ font-size: 40px \}.*perf\.css:2/);
    assert.match(d.text, /Accessibility: role heading/);
    const btn = await ok(mcp.client, 'dom_inspect', { selector: '#slow', include: ['listeners'] });
    assert.match(btn.text, /click → /);
  });

  it('reads and edits application storage', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/storage.html` });
    await ok(mcp.client, 'wait_for', { text: 'ready', timeoutMs: 8000 });
    const cookies = await ok(mcp.client, 'storage', { area: 'cookies' });
    assert.match(cookies.text, /session_id=abc123/);
    await ok(mcp.client, 'storage', { area: 'cookies', action: 'set', key: 'agent', value: 'neo', httpOnly: true });
    assert.match((await ok(mcp.client, 'storage', { area: 'cookies', key: 'agent' })).text, /agent=neo .*HttpOnly/);
    await ok(mcp.client, 'storage', { area: 'cookies', action: 'remove', key: 'agent' });
    assert.doesNotMatch((await ok(mcp.client, 'storage', { area: 'cookies' })).text, /agent=neo/);
    const local = await ok(mcp.client, 'storage', { area: 'local' });
    assert.match(local.text, /user = \{"name":"tester","plan":"pro"\}/);
    await ok(mcp.client, 'storage', { area: 'local', action: 'set', key: 'fromAgent', value: '42' });
    assert.match((await ok(mcp.client, 'storage', { area: 'local', action: 'get', key: 'fromAgent' })).text, /42/);
    assert.match((await ok(mcp.client, 'storage', { area: 'session' })).text, /tab = one/);
    const idb = await ok(mcp.client, 'storage', { area: 'indexeddb' });
    assert.match(idb.text, /- shopdb \(v1\)/);
    assert.match(idb.text, /- products: 2 records · keyPath "id" · indexes byName/);
    const records = await ok(mcp.client, 'storage', { area: 'indexeddb', key: 'shopdb/products' });
    assert.match(records.text, /shopdb\/products: 2 records/);
    assert.match(records.text, /- key 1: \{"id":1,"name":"Pen"/);
    assert.match(records.text, /"added":"2026-01-02T00:00:00.000Z"/);
    const cache = await ok(mcp.client, 'storage', { area: 'cache', key: 'assets-v1' });
    assert.match(cache.text, /holds 2 entries[\s\S]*cached\/a\.json/);
    const sw = await ok(mcp.client, 'storage', { area: 'serviceworkers' });
    assert.match(sw.text, /sw\.js \((activated|activating)\)/);
    const manifest = await ok(mcp.client, 'storage', { area: 'manifest' });
    assert.match(manifest.text, /name: Neo Fixture App/);
    const quota = await ok(mcp.client, 'storage', { area: 'quota' });
    assert.match(quota.text, /used of/);
    // The page can still open its database afterwards (we closed ours).
    const reopen = await ok(mcp.client, 'evaluate', { expression: 'new Promise(r => { const q = indexedDB.open("shopdb", 2); q.onsuccess = () => { q.result.close(); r("reopened v2"); }; q.onblocked = () => r("blocked"); })' });
    assert.match(reopen.text, /reopened v2/);
  });

  it('reports DevTools issues', async () => {
    const issues = await ok(mcp.client, 'devtools_issues');
    assert.match(issues.text, /CookieIssue|Cookie/);
  });

  it('emulates devices and conditions, then resets', async () => {
    const probe = async () =>
      (await ok(mcp.client, 'evaluate', { function: '() => ({ ua: navigator.userAgent, width: innerWidth, dpr: devicePixelRatio, dark: matchMedia("(prefers-color-scheme: dark)").matches, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language, touch: navigator.maxTouchPoints })' })).text;
    const original = await probe();
    const e = await ok(mcp.client, 'emulate', { device: 'iphone-15-pro', colorScheme: 'dark', timezone: 'Asia/Ho_Chi_Minh', locale: 'vi-VN' });
    assert.match(e.text, /The page sees screen 393×852 @3x \(layout viewport 980×\d+, the page has no <meta name=viewport>\), touch points 5, language vi-VN \(Intl vi-VN\), timezone Asia\/(Ho_Chi_Minh|Saigon), dark mode on/);
    const ua = await ok(mcp.client, 'evaluate', { expression: 'navigator.userAgent' });
    assert.match(ua.text, /iPhone/);
    await ok(mcp.client, 'emulate', { network: 'offline' });
    const off = await ok(mcp.client, 'evaluate', { expression: 'fetch("/api/echo").then(() => "online", () => "offline")' });
    assert.match(off.text, /offline/);
    const reset = await ok(mcp.client, 'emulate', { reset: true });
    assert.doesNotMatch(reset.text, /393×852/);
    const on = await ok(mcp.client, 'evaluate', { expression: 'fetch("/api/echo").then(() => "online", () => "offline")' });
    assert.match(on.text, /online/);
    assert.equal(await probe(), original, 'reset brings the tab back to exactly its previous state');
  });

  it('reads memory counters and reports heap snapshot availability', async () => {
    const m = await ok(mcp.client, 'memory');
    assert.match(m.text, /JS heap: .* used of/);
    assert.match(m.text, /DOM nodes: \d+/);
    const snap = await call(mcp.client, 'memory', { action: 'snapshot' }, 120_000);
    assert.ok(snap.isError, 'without a remote debugging endpoint the snapshot must fail clearly');
    assert.match(snap.text, /full DevTools channel/);
  });

  it('sends raw CDP commands and reads raw events', async () => {
    const r = await ok(mcp.client, 'cdp_send', { method: 'Page.getLayoutMetrics' });
    assert.match(r.text, /cssVisualViewport/);
    const ignored = await ok(mcp.client, 'cdp_send', { method: 'Network.disable' });
    assert.match(ignored.text, /Ignored Network\.disable/);
    await ok(mcp.client, 'cdp_events', { action: 'subscribe', events: ['Page.loadEventFired', 'Network.*'] });
    await ok(mcp.client, 'navigate', { action: 'reload' });
    const events = await ok(mcp.client, 'cdp_events', { action: 'read' });
    assert.match(events.text, /Page\.loadEventFired/);
    assert.match(events.text, /Network\.requestWillBeSent/);
    // Network still works after the ignored disable.
    assert.match((await ok(mcp.client, 'network_requests')).text, /storage\.html/);
    const blocked = await call(mcp.client, 'cdp_send', { method: 'HeapProfiler.getSamplingProfile' }, 60_000);
    assert.ok(blocked.isError);
    assert.match(blocked.text, /full DevTools channel/);
    const dbg = await ok(mcp.client, 'cdp_send', { method: 'Debugger.enable' });
    assert.match(dbg.text, /Pausing on breakpoints\/debugger statements is skipped/);
    const still = await ok(mcp.client, 'evaluate', { expression: '(() => { debugger; return "not frozen"; })()' });
    assert.match(still.text, /not frozen/);
    await ok(mcp.client, 'cdp_send', { method: 'Debugger.disable' });
  });

  it('saves binary response bodies to a file', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/index.html` });
    const list = await ok(mcp.client, 'network_requests', { urlPattern: 'pixel.png' });
    const id = list.text.match(/(r\d+) GET 200 Image/)![1]!;
    const detail = await ok(mcp.client, 'network_request', { id });
    const file = detail.text.match(/Response body saved to (.+\.png) \(\d+ B\)/)?.[1];
    assert.ok(file, detail.text);
    assert.equal(readFileSync(file).subarray(1, 4).toString(), 'PNG');
  });

  it('keeps console and network buffers bounded, dropping the oldest entries', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/page2.html` });
    await ok(mcp.client, 'evaluate', { expression: 'for (let i = 0; i < 1100; i++) console.log("bulk-" + i)' });
    await sleep(500);
    const logs = await ok(mcp.client, 'console_logs', { pattern: '^bulk-(0|99|100|1099)$', limit: 10 });
    assert.match(logs.text, /\(buffer 1000\)/);
    assert.match(logs.text, /bulk-100\b/);
    assert.match(logs.text, /bulk-1099\b/);
    assert.doesNotMatch(logs.text, /bulk-(0|99)\b/);
    await ok(mcp.client, 'evaluate', { expression: 'Promise.all(Array.from({ length: 1010 }, (_, i) => fetch("/api/echo?n=" + i))).then(() => "done")' }, 120_000);
    await sleep(500);
    assert.match((await ok(mcp.client, 'network_requests', { urlPattern: '/[?]n=0$/' })).text, /No requests match \(buffer holds 1000;/);
    assert.match((await ok(mcp.client, 'network_requests', { urlPattern: '/[?]n=1009$/' })).text, /^1 of 1 requests/);
  });
});

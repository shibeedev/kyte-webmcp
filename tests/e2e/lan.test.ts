/**
 * LAN: the side panel switch starts the LAN endpoint through Chrome native messaging, and MCP clients on
 * other machines drive the browser over HTTP with the access token. The test build registers its own host
 * name (com.kyte.webmcp.test, removed afterwards) and port (17950), so the user's real setup is never touched.
 * Screenshots go to tests/.artifacts/ui.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { ARTIFACTS, CLI, TEST_ENV, call, extensionWorker, launchBrowser, ok, refOf, sleep, startClient, waitConnected, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';
import { allToolSpecs } from '../../src/features/specs.ts';
import { isPrivateAddress } from '../../src/bridge/lan.ts';
import { encodeNative, NativeReader } from '../../src/bridge/native-host.ts';
import { LAN_PATH, LAN_PORT } from '../../src/shared/constants.ts';

const SHOTS = path.join(ARTIFACTS, 'ui');
mkdirSync(SHOTS, { recursive: true });
/** The test build moves the LAN port up by 100, like the bridge ports. */
const PORT = LAN_PORT + 100;

function cli(command: string): string {
  return execFileSync(process.execPath, [CLI, command], { env: { ...process.env, ...TEST_ENV }, encoding: 'utf8' });
}

async function openSidePanel(bh: BrowserHandle): Promise<Page> {
  const sw = await extensionWorker(bh.browser);
  await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', width: 420, height: 900 }));
  const target = await bh.browser.waitForTarget((t) => t.url().endsWith('/sidepanel.html'));
  const page = (await target.page())!;
  await page.setViewport({ width: 400, height: 1400 });
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent !== '');
  return page;
}

async function waitText(page: Page, selector: string, pattern: RegExp, timeout = 10_000): Promise<string> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = await page.$eval(selector, (el) => (el as HTMLElement).innerText).catch(() => '');
    if (pattern.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`${selector} never matched ${pattern}; last: ${text.slice(0, 500)}`);
    await sleep(100);
  }
}

async function waitFor(check: () => Promise<boolean>, what: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const shown = (page: Page, selector: string) => page.$eval(selector, (el) => !(el as HTMLElement).hidden && (el as HTMLElement).offsetParent !== null);
const sessionsText = (page: Page) => page.$eval('#sessions', (el) => (el as HTMLElement).innerText);

/** What the side panel tells the user to run on the other computer. */
async function connection(panel: Page): Promise<{ url: string; address: string; token: string }> {
  const cmd = await panel.$eval('#cmd-lan-claude', (el) => el.textContent ?? '');
  const m = /^claude mcp add --transport http kyte-webmcp-lan (http:\/\/([^:/]+):(\d+)\/mcp) --header "Authorization: Bearer ([A-Za-z0-9_-]{20,})"$/.exec(cmd);
  assert.ok(m, `unexpected command: ${cmd}`);
  return { url: m[1]!, address: m[2]!, token: m[4]! };
}

async function lanClient(url: string, token: string, name: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** HTTP status of a bare request to the LAN endpoint, or the connection error code. */
async function probe(url: string, headers: Record<string, string> = {}): Promise<string> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}' });
    await res.body?.cancel();
    return String(res.status);
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause?.code ?? String(error);
  }
}

/** Plain JSON-RPC over HTTP that never opens the standalone SSE stream, like MCP clients that skip it. */
class RawClient {
  sid = '';
  #id = 1;
  readonly url: string;
  readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  async rpc(method: string, params: Record<string, unknown> = {}, notification = false): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.token}`, ...(this.sid ? { 'mcp-session-id': this.sid } : {}) },
      body: JSON.stringify(notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: this.#id++, method, params }),
    });
    this.sid ||= res.headers.get('mcp-session-id') ?? '';
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    if (notification) return null;
    const lines = text.split('\n').filter((l) => l.startsWith('data: '));
    const message = lines.length ? lines.map((l) => JSON.parse(l.slice(6))).find((m) => 'result' in m || 'error' in m) : JSON.parse(text);
    if (message.error) throw new Error(JSON.stringify(message.error));
    return message.result;
  }

  async connect(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-lan', version: '1.0.0' } });
    await this.rpc('notifications/initialized', {}, true);
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    return { text: r.content.map((c: { text?: string }) => c.text ?? '').join('\n'), isError: !!r.isError };
  }
}

describe('LAN connections (English)', () => {
  let srv: FixtureServers;
  let bh: BrowserHandle;
  let panel: Page;
  let conn: { url: string; address: string; token: string };
  let lan: { client: Client; transport: StreamableHTTPClientTransport };
  let local: McpHandle;
  const clients: Client[] = [];

  before(async () => {
    srv = await startFixtureServers();
    cli('uninstall'); // clean slate, even after an interrupted run
    bh = await launchBrowser();
    panel = await openSidePanel(bh);
  });
  after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await local?.close();
    await bh?.close();
    await srv?.close();
    cli('uninstall');
  });

  it('is off by default: nothing listens on the LAN port', async () => {
    assert.equal(await panel.$eval('#set-lan', (el) => (el as HTMLInputElement).checked), false);
    await waitText(panel, '#lan-state', /Only MCP clients on this computer can connect/);
    assert.equal(await shown(panel, '#lan-ready'), false);
    assert.equal(await shown(panel, '#lan-install'), false);
    assert.equal(await probe(`http://127.0.0.1:${PORT}${LAN_PATH}`), 'ECONNREFUSED');
  });

  it('turned on before the LAN component is installed, it shows the install command', async () => {
    await panel.click('#set-lan');
    await waitText(panel, '#lan-state', /not installed on this computer/);
    assert.equal(await shown(panel, '#lan-install'), true);
    assert.match(await panel.$eval('#cmd-lan-install', (el) => el.textContent ?? ''), /^node ".+" install$/);
    assert.equal(await probe(`http://127.0.0.1:${PORT}${LAN_PATH}`), 'ECONNREFUSED');
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-lan-not-installed-en.png'), fullPage: true });
  });

  it('starts by itself once installed and shows the command for the other computer', async (t) => {
    assert.match(cli('install'), /com\.kyte\.webmcp\.test/);
    const started = Date.now();
    // Nobody touches the switch: the extension's wake-up alarm retries the host.
    await waitText(panel, '#lan-state', new RegExp(`On · port ${PORT}`), 45_000);
    t.diagnostic(`LAN endpoint up ${Date.now() - started} ms after install`);
    assert.equal(await shown(panel, '#lan-install'), false);
    assert.equal(await shown(panel, '#lan-ready'), true);
    conn = await connection(panel);
    assert.ok(isPrivateAddress(conn.address), conn.address);
    assert.equal(conn.url, `http://${conn.address}:${PORT}${LAN_PATH}`);
    const json = JSON.parse(await panel.$eval('#cmd-lan-json', (el) => el.textContent ?? ''));
    assert.deepEqual(json, { mcpServers: { 'kyte-webmcp-lan': { type: 'http', url: conn.url, headers: { Authorization: `Bearer ${conn.token}` } } } });
    t.diagnostic(`endpoint ${conn.url}`);
  });

  it('a LAN client drives the browser with the token', async () => {
    lan = await lanClient(conn.url, conn.token, 'kyte-lan');
    clients.push(lan.client);
    assert.equal((await lan.client.listTools()).tools.length, allToolSpecs.length);
    assert.match(lan.client.getInstructions() ?? '', /over the LAN/);
    await waitConnected(lan.client, 20_000);
    assert.match((await ok(lan.client, 'browser_status')).text, new RegExp(`Connection: over the LAN from ${conn.address.replace(/\./g, '\\.')}`));
    await ok(lan.client, 'tab_open', { url: `${srv.a}/index.html` });
    const snap = await ok(lan.client, 'page_snapshot');
    await ok(lan.client, 'type', { ref: refOf(snap.text, /textbox "Email"/), text: 'lan@example.com' });
    await ok(lan.client, 'click', { ref: refOf(snap.text, /button "Call API"/) });
    await ok(lan.client, 'wait_for', { text: 'echo:' });
    const values = await ok(lan.client, 'evaluate', { expression: '[document.getElementById("email").value, document.getElementById("result").textContent]' });
    assert.deepEqual(JSON.parse(values.text.replace(/^array: /, '')), ['lan@example.com', 'echo:{"hello":"world"}']);
    const shot = await ok(lan.client, 'screenshot');
    assert.equal(shot.images.length, 1);
    // The user sees who is in control, from which computer.
    const sessions = await waitText(panel, '#sessions', /kyte-lan @ /);
    assert.match(sessions, new RegExp(`kyte-lan @ ${conn.address.replace(/\./g, '\\.')}`));
    assert.match(sessions, /LAN/);
    await waitText(panel, '#activity', /tab_open/);
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-lan-on-en.png'), fullPage: true });
  });

  it('refuses a missing or wrong token and requests from web pages', async () => {
    assert.equal(await probe(conn.url), '401');
    assert.equal(await probe(conn.url, { authorization: 'Bearer wrong-token' }), '401');
    assert.equal(await probe(conn.url, { authorization: `Bearer ${conn.token}`, origin: `http://${conn.address}:8080` }), '403');
    assert.equal(await probe(conn.url, { authorization: `Bearer ${conn.token}` }), '400'); // right token, no session: reaches MCP
    // A real web page cannot use the endpoint, even if it knew the token.
    const page = await bh.browser.newPage();
    await page.goto(`${srv.a}/page2.html`);
    const fromPage = await page.evaluate(async (url: string, token: string) => {
      try {
        const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
        return `status ${r.status}`;
      } catch {
        return 'blocked';
      }
    }, conn.url, conn.token);
    await page.close();
    assert.equal(fromPage, 'blocked');
  });

  it('LAN and local clients work side by side and stay apart', async () => {
    local = await startClient(17837, { name: 'kyte-local' });
    await waitConnected(local.client);
    await ok(local.client, 'tab_open', { url: `${srv.b}/page2.html` });
    assert.match((await ok(lan.client, 'page_info')).text, /Kyte Test Shop/);
    assert.match((await ok(local.client, 'page_info')).text, /Second page/);
    await waitText(panel, '#status', /Connected sessions: 2/);
    const sessions = await sessionsText(panel);
    assert.match(sessions, /kyte-local/);
    assert.doesNotMatch(sessions, /kyte-local @/);
  });

  it('a client that ends its session leaves the browser at once', async () => {
    const b = await lanClient(conn.url, conn.token, 'kyte-lan-b');
    await waitConnected(b.client);
    await waitText(panel, '#sessions', /kyte-lan-b/);
    await b.transport.terminateSession();
    await b.client.close();
    await waitFor(async () => !(await sessionsText(panel)).includes('kyte-lan-b'), 'the ended session to leave', 5000);
  });

  it('a client that goes quiet is released after a minute and resumes when it calls again', async (t) => {
    const raw = new RawClient(conn.url, conn.token);
    await raw.connect();
    assert.equal((await raw.tool('tab_open', { url: `${srv.a}/page2.html` })).isError, false);
    await waitText(panel, '#sessions', /raw-lan/);
    const gone = await lanClient(conn.url, conn.token, 'kyte-lan-gone');
    await waitConnected(gone.client);
    await waitText(panel, '#sessions', /kyte-lan-gone/);
    await gone.client.close(); // no DELETE: like a client process that was killed
    const started = Date.now();
    await waitFor(
      async () => {
        const s = await sessionsText(panel);
        return !s.includes('raw-lan') && !s.includes('kyte-lan-gone');
      },
      'quiet LAN sessions to be released',
      100_000,
    );
    t.diagnostic(`released ${Date.now() - started} ms after going quiet`);
    // The client that keeps its event stream open stays connected the whole time.
    assert.match(await sessionsText(panel), /kyte-lan @ /);
    // Same MCP session, new browser session.
    const back = await raw.tool('tabs_list');
    assert.equal(back.isError, false, back.text);
    await waitText(panel, '#sessions', /raw-lan/);
    await raw.rpc('tools/list');
  });

  it('a new access token disconnects LAN clients and only the new one works', async () => {
    const old = conn.token;
    await panel.click('#lan-new-token');
    await waitFor(async () => (await connection(panel)).token !== old, 'the new token');
    conn = await connection(panel);
    await waitFor(async () => !(await sessionsText(panel)).includes(' @ '), 'LAN sessions to end', 5000);
    await assert.rejects(call(lan.client, 'page_info'), /401|access token/);
    assert.equal(await probe(conn.url, { authorization: `Bearer ${old}` }), '401');
    const c = await lanClient(conn.url, conn.token, 'kyte-lan-c');
    clients.push(c.client);
    await waitConnected(c.client);
    assert.match((await ok(c.client, 'page_info')).text, /Kyte Test Shop|Second page/);
    await waitText(panel, '#status', /Connected sessions: 2/); // kyte-local + kyte-lan-c
    lan = c;
  });

  it('comes back by itself after the service worker restarts', async () => {
    const worker = await extensionWorker(bh.browser);
    await worker.close(); // stops the MV3 service worker; its native port (and so the LAN host) goes with it
    await sleep(500);
    const page = await bh.browser.newPage(); // any browsing event wakes the worker
    await page.goto(`${srv.a}/index.html`);
    await waitFor(async () => (await probe(conn.url, { authorization: `Bearer ${conn.token}` })) === '400', 'the LAN endpoint to come back', 20_000);
    // It is a new LAN host: the old MCP session is gone and the client reconnects.
    await assert.rejects(call(lan.client, 'page_info'), /404|Session not found/);
    const d = await lanClient(conn.url, conn.token, 'kyte-lan-d');
    clients.push(d.client);
    await waitConnected(d.client);
    await ok(d.client, 'page_info');
    await waitText(panel, '#lan-state', new RegExp(`On · port ${PORT}`));
    await page.close();
  });

  it('turning it off closes the LAN port and ends LAN sessions; local sessions stay', async () => {
    await panel.click('#set-lan');
    await waitText(panel, '#lan-state', /Only MCP clients on this computer can connect/);
    await waitFor(async () => (await probe(conn.url)) === 'ECONNREFUSED', 'the LAN port to close', 5000);
    await waitFor(async () => !(await sessionsText(panel)).includes(' @ '), 'LAN sessions to end', 5000);
    await waitText(panel, '#status', /Connected sessions: 1/);
    assert.equal(await shown(panel, '#lan-ready'), false);
    await ok(local.client, 'page_info');
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-lan-off-en.png'), fullPage: true });
  });

  it('refuses LAN bridges while LAN connections are off, even from a host started by hand', async (t) => {
    const host = spawn(process.execPath, [CLI, 'lan-host'], { env: { ...process.env, ...TEST_ENV }, stdio: ['pipe', 'pipe', 'pipe'] });
    const messages: Array<{ t: string }> = [];
    const reader = new NativeReader((m) => messages.push(m as { t: string }));
    host.stdout.on('data', (chunk: Buffer) => reader.push(chunk));
    let stderr = '';
    host.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)));
    try {
      host.stdin.write(encodeNative({ t: 'start', token: 'by-hand' }));
      await waitFor(async () => messages.some((m) => m.t === 'listening'), 'the hand-started host to listen');
      const e = await lanClient(`http://127.0.0.1:${PORT}${LAN_PATH}`, 'by-hand', 'kyte-lan-by-hand');
      const started = Date.now();
      // The extension finds the bridge, sees that it serves a LAN client and closes it.
      await waitFor(async () => /extension .* connected[\s\S]*extension disconnected/.test(stderr), 'the extension to refuse the LAN bridge', 45_000).catch((error: Error) => {
        throw new Error(`${error.message}\nhost stderr:\n${stderr}`);
      });
      t.diagnostic(`refused ${Date.now() - started} ms after the bridge opened`);
      assert.match((await call(e.client, 'browser_status')).text, /Extension: NOT connected/);
      assert.doesNotMatch(await sessionsText(panel), /by-hand/);
      await e.client.close();
    } finally {
      host.stdin.end();
      await new Promise((resolve) => (host.exitCode !== null ? resolve(null) : host.once('exit', resolve)));
    }
  });
});

describe('LAN connections (Vietnamese)', () => {
  let bh: BrowserHandle;

  before(() => {
    cli('install');
  });
  after(async () => {
    await bh?.close();
    cli('uninstall');
  });

  it('shows the switch, status and commands in Vietnamese', async () => {
    bh = await launchBrowser({ lang: 'vi' });
    const panel = await openSidePanel(bh);
    assert.equal(await panel.$eval('#h-lan', (el) => el.textContent), 'Điều khiển từ máy khác (LAN)');
    assert.match(await panel.$eval('#set-lan', (el) => (el.closest('label') as HTMLElement).innerText), /Cho phép máy trong mạng LAN kết nối/);
    await waitText(panel, '#lan-state', /Chỉ MCP client trên máy này kết nối được/);
    await panel.click('#set-lan');
    await waitText(panel, '#lan-state', new RegExp(`Đang bật · cổng ${PORT}`), 20_000);
    const ready = await panel.$eval('#lan-ready', (el) => (el as HTMLElement).innerText);
    for (const text of ['Địa chỉ của máy này', 'Trên máy kia: Claude Code', 'Đổi mã truy cập', 'chỉ bật trên mạng bạn tin cậy']) assert.ok(ready.includes(text), `missing "${text}" in:\n${ready}`);
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-lan-on-vi.png'), fullPage: true });
    await panel.click('#set-lan');
    await waitText(panel, '#lan-state', /Chỉ MCP client trên máy này/);
    await waitFor(async () => (await probe(`http://127.0.0.1:${PORT}${LAN_PATH}`)) === 'ECONNREFUSED', 'the LAN port to close', 5000);
  });
});

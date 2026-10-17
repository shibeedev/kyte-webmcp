/** UI: side panel states and controls, in-page indicator behaviour, Vietnamese locale. Screenshots go to tests/.artifacts/ui. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Page } from 'puppeteer-core';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { ARTIFACTS, CLI, call, extensionWorker, launchBrowser, ok, sleep, startClient, waitConnected, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';

const SHOTS = path.join(ARTIFACTS, 'ui');
mkdirSync(SHOTS, { recursive: true });

async function openSidePanel(bh: BrowserHandle): Promise<Page> {
  const sw = await extensionWorker(bh.browser);
  await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', width: 420, height: 900 }));
  const target = await bh.browser.waitForTarget((t) => t.url().endsWith('/sidepanel.html'));
  const page = (await target.page())!;
  await page.setViewport({ width: 400, height: 860 });
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

async function fixturePage(bh: BrowserHandle, urlPart: string): Promise<Page> {
  const target = await bh.browser.waitForTarget((t) => t.url().includes(urlPart));
  return (await target.page())!;
}

/** Average colour of a thin strip along the left edge (where the indicator border is drawn). */
async function leftEdge(png: Buffer | Uint8Array): Promise<[number, number, number]> {
  const img = sharp(Buffer.from(png));
  const { height = 100 } = await img.metadata();
  // stats() reads the input image, so cut the strip out into its own buffer first.
  const strip = await img.extract({ left: 0, top: Math.round(height * 0.4), width: 3, height: 40 }).png().toBuffer();
  const stats = await sharp(strip).stats();
  return stats.channels.slice(0, 3).map((c) => Math.round(c.mean)) as [number, number, number];
}
/** The border pulses between strong and light system blue; on a white page both read as "blue well above red and green". */
const isAccentBlue = ([r, g, b]: [number, number, number]) => b - g > 40 && b - r > 70;

describe('side panel and indicator (English)', () => {
  let srv: FixtureServers;
  let bh: BrowserHandle;
  let mcp: McpHandle;
  let panel: Page;

  before(async () => {
    srv = await startFixtureServers();
    bh = await launchBrowser();
  });
  after(async () => {
    await mcp?.close();
    await bh?.close();
    await srv?.close();
  });

  it('shows the waiting state with setup help before any client connects', async () => {
    panel = await openSidePanel(bh);
    assert.match(await waitText(panel, '#status', /Waiting for an MCP client/), /Waiting/);
    assert.equal(await panel.$eval('#setup', (d) => (d as HTMLDetailsElement).open), true);
    assert.match(await panel.$eval('#cmd-claude', (e) => e.textContent ?? ''), /claude mcp add kyte-webmcp -- node "<path-to-kyte-webmcp>\/dist\/bridge\/cli\.mjs"/);
    assert.match(await panel.$eval('#no-sessions', (e) => (e as HTMLElement).innerText), /No MCP client is connected yet/);
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-waiting-en.png') });
  });

  it('updates live when a client connects and shows the exact setup command', async () => {
    mcp = await startClient(17832, { name: 'kyte-ui' });
    await waitConnected(mcp.client);
    await waitText(panel, '#status', /Connected sessions: 1/);
    const session = await waitText(panel, '#sessions', /kyte-ui/);
    assert.match(session, /Target: follows your active tab/);
    assert.equal(await waitText(panel, '#cmd-claude', /cli\.mjs"$/), `claude mcp add kyte-webmcp -- node "${CLI}"`);
    assert.equal(await panel.$eval('#stop-all', (b) => (b as HTMLButtonElement).hidden), false);
  });

  it('streams the activity log with details and filtering', async () => {
    await ok(mcp.client, 'tab_open', { url: `${srv.a}/index.html` });
    await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    const log = await waitText(panel, '#activity', /page_snapshot/);
    assert.match(log, /tab_open/);
    assert.match(log, /✓ \d+ ms/);
    const session = await waitText(panel, '#sessions', /Idle/);
    assert.match(session, /Target: "Kyte Test Shop"/);
    await panel.click('#activity li[data-id]');
    assert.equal(await panel.$eval('#activity li[data-id]', (li) => li.classList.contains('open')), true);
    await panel.type('#filter', 'snapshot');
    const filtered = await panel.$$eval('#activity .tool', (els) => els.map((e) => e.textContent));
    assert.ok(filtered.length > 0 && filtered.every((t) => t === 'page_snapshot'), JSON.stringify(filtered));
    await panel.$eval('#filter', (i) => ((i as HTMLInputElement).value = ''));
    await panel.type('#filter', ' ');
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-connected-en.png') });
  });

  it('keeps the indicator out of layout, accessibility tree and agent screenshots, and lets clicks through', async () => {
    const page = await fixturePage(bh, '/index.html');
    const before = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, bottom: document.getElementById('bottom')!.getBoundingClientRect().top }));
    const running = call(mcp.client, 'wait_for', { timeMs: 2500 });
    await page.waitForSelector('kyte-webmcp-indicator', { visible: true, timeout: 5000 });
    const afterShow = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, bottom: document.getElementById('bottom')!.getBoundingClientRect().top }));
    assert.deepEqual(afterShow, before, 'indicator must not change the layout');
    assert.equal(await page.$eval('kyte-webmcp-indicator', (e) => e.getAttribute('aria-hidden')), 'true');
    const hits = await page.evaluate(() => {
      const at = (x: number, y: number) => document.elementFromPoint(x, y)?.tagName ?? null;
      return { edge: at(1, 300), pillLabel: at(innerWidth / 2 - 60, 22), center: at(innerWidth / 2, innerHeight / 2) };
    });
    assert.notEqual(hits.edge, 'KYTE-WEBMCP-INDICATOR');
    assert.notEqual(hits.pillLabel, 'KYTE-WEBMCP-INDICATOR');
    assert.notEqual(hits.center, 'KYTE-WEBMCP-INDICATOR');
    const userView = await page.screenshot({ type: 'png', path: path.join(SHOTS, 'indicator-active.png') });
    const edge = await leftEdge(userView);
    assert.ok(isAccentBlue(edge), `the user sees the blue border (left edge colour ${edge.join(',')})`);
    await running;
    const agentShot = await ok(mcp.client, 'screenshot', { format: 'png', maxWidth: 1280 });
    assert.ok(!isAccentBlue(await leftEdge(Buffer.from(agentShot.images[0]!.data, 'base64'))), 'the agent screenshot hides the indicator');
    const snap = await ok(mcp.client, 'page_snapshot');
    assert.doesNotMatch(snap.text, /controlling this tab/);
  });

  it('pauses and resumes from the side panel', async () => {
    await panel.click('#sessions button');
    await waitText(panel, '#sessions', /Paused/);
    await waitText(panel, '#status', /Connected sessions: 1/);
    const refused = await call(mcp.client, 'page_info');
    assert.ok(refused.isError);
    assert.match(refused.text, /paused browser control/);
    const page = await fixturePage(bh, '/index.html');
    await page.waitForSelector('kyte-webmcp-indicator', { visible: true, timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, 'indicator-paused.png') });
    await panel.click('#sessions button');
    await waitText(panel, '#sessions', /Idle|Working/);
    await ok(mcp.client, 'page_info');
  });

  it('stops the agent from the Stop button on the page', async () => {
    const page = await fixturePage(bh, '/index.html');
    const running = call(mcp.client, 'wait_for', { timeMs: 4000 });
    await page.waitForSelector('kyte-webmcp-indicator', { visible: true, timeout: 5000 });
    // The button lives in a closed shadow root: locate it through CDP, then click like a user.
    const cdp = await page.createCDPSession();
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const findButton = (n: any): number | undefined => {
      if (n.nodeName === 'BUTTON' && JSON.stringify(n).length < 2000 && n.parentId) return n.nodeId;
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
        const f = findButton(c);
        if (f) return f;
      }
      return undefined;
    };
    const host = (function find(n: any): any {
      if (n.nodeName === 'KYTE-WEBMCP-INDICATOR') return n;
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
        const f = find(c);
        if (f) return f;
      }
      return undefined;
    })(root);
    const buttonId = findButton(host);
    assert.ok(buttonId, 'stop button found in the closed shadow root');
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: buttonId! });
    const [x1, y1, , , x3, y3] = model.content;
    await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
    const stopped = await running;
    assert.ok(stopped.isError);
    assert.match(stopped.text, /pressed Stop/);
    await waitText(panel, '#sessions', /Paused/);
    await waitText(panel, '#stop-all', /Resume all/);
    await panel.click('#stop-all');
    await waitText(panel, '#sessions', /Idle|Working/);
    await ok(mcp.client, 'page_info');
  });

  it('persists settings and honours the indicator switch', async () => {
    await panel.click('#set-overlay');
    const sw = await extensionWorker(bh.browser);
    for (let i = 0; i < 50 && (await sw.evaluate(() => chrome.storage.local.get('settings').then((s) => (s.settings as { overlay?: boolean })?.overlay))) !== false; i++) await sleep(100);
    assert.equal(await sw.evaluate(() => chrome.storage.local.get('settings').then((s) => (s.settings as { overlay?: boolean })?.overlay)), false);
    const page = await fixturePage(bh, '/index.html');
    await ok(mcp.client, 'wait_for', { timeMs: 600 });
    assert.equal(await page.$('kyte-webmcp-indicator'), null, 'indicator removed when switched off');
    await panel.select('#set-whisper', 'small');
    await panel.reload();
    await panel.waitForFunction(() => document.getElementById('status-text')?.textContent !== '');
    await sleep(300);
    assert.equal(await panel.$eval('#set-overlay', (i) => (i as HTMLInputElement).checked), false);
    assert.equal(await panel.$eval('#set-whisper', (s) => (s as HTMLSelectElement).value), 'small');
    await panel.click('#set-overlay');
    await panel.select('#set-whisper', 'base');
  });

  it('lists the WebMCP tools of the tab the user is looking at', async () => {
    await ok(mcp.client, 'tab_open', { url: `${srv.a}/webmcp.html` });
    await ok(mcp.client, 'webmcp_list');
    const tools = await waitText(panel, '#webmcp', /add_todo/);
    assert.match(tools, /list_todos\s*READ-ONLY/i);
    assert.match(tools, /clear_todos\s*CONSEQUENTIAL/i);
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-webmcp-en.png') });
    await panel.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-webmcp-light.png') });
    await panel.emulateMediaFeatures([]);
  });
});

describe('side panel (Vietnamese)', () => {
  let bh: BrowserHandle;
  after(async () => bh?.close());

  it('follows the Chrome UI language', async () => {
    bh = await launchBrowser({ lang: 'vi' });
    const panel = await openSidePanel(bh);
    assert.match(await waitText(panel, '#status', /Đang chờ MCP client/), /Đang chờ/);
    assert.match(await panel.$eval('#h-sessions', (e) => e.textContent ?? ''), /Phiên làm việc/);
    assert.match(await panel.$eval('#setup summary', (e) => e.textContent ?? ''), /Kết nối MCP client/);
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-waiting-vi.png') });
  });
});

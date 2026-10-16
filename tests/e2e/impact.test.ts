/**
 * Impact: the extension must not change pages the agent never touched, must clean up everything when a
 * session ends, keep sessions apart, recover from restarts and stay cheap when idle.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { Browser, Page } from 'puppeteer-core';
import { EXTENSION_ID, EXTENSION_ORIGIN } from '../../src/shared/constants.ts';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { bridgePort, call, extensionWorker, lanAddress, launchBrowser, ok, sleep, startClient, waitConnected, wsAttempt, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';

let srv: FixtureServers;

interface PageProbe {
  globals: string[];
  html: string;
  attrs: string;
  console: string[];
  screenshot: Uint8Array;
  loadMs: number[];
}

/** Loads a page directly (not through the agent) and records everything that could reveal interference. */
async function probe(browser: Browser, url: string): Promise<PageProbe> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const consoleMessages: string[] = [];
  page.on('console', (m) => consoleMessages.push(`${m.type()}: ${m.text()}`));
  const loadMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    for (let attempt = 0; ; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'load' });
        break;
      } catch (error) {
        // A brand-new tab can abort its very first navigation; retry like a user would.
        if (attempt >= 2 || !String(error).includes('ERR_ABORTED')) throw error;
      }
    }
    loadMs.push(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventEnd));
  }
  await sleep(300);
  const state = await page.evaluate(() => ({
    globals: Object.keys(window).sort(),
    html: document.documentElement.outerHTML,
    attrs: Array.from(document.documentElement.attributes).map((a) => `${a.name}=${a.value}`).join(' '),
  }));
  const screenshot = await page.screenshot({ type: 'png' });
  await page.close();
  return { ...state, console: consoleMessages, screenshot, loadMs };
}

async function pixelDiff(a: Uint8Array, b: Uint8Array): Promise<number> {
  const [ra, rb] = await Promise.all([sharp(Buffer.from(a)).raw().toBuffer({ resolveWithObject: true }), sharp(Buffer.from(b)).raw().toBuffer({ resolveWithObject: true })]);
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return 1;
  let diff = 0;
  for (let i = 0; i < ra.data.length; i++) if (Math.abs(ra.data[i]! - rb.data[i]!) > 8) diff++;
  return diff / ra.data.length;
}

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;

/** Tabs the extension itself holds a debugger session on (getTargets().attached also counts Puppeteer). */
async function attachedTabs(browser: Browser): Promise<number[]> {
  const sw = await extensionWorker(browser);
  return sw.evaluate(async () => {
    const out: number[] = [];
    for (const tab of await chrome.tabs.query({})) {
      try {
        await chrome.debugger.sendCommand({ tabId: tab.id! }, 'Runtime.evaluate', { expression: '1' });
        out.push(tab.id!);
      } catch {
        /* not attached by the extension */
      }
    }
    return out;
  });
}

async function tabIdOf(browser: Browser, page: Page): Promise<number> {
  const sw = await extensionWorker(browser);
  const url = page.url();
  return sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)!.id!, url);
}

describe('impact on pages and the browser', () => {
  before(async () => {
    srv = await startFixtureServers();
  });
  after(async () => srv?.close());

  it('leaves pages the agent never touched exactly as without the extension', async (t) => {
    const plain = await launchBrowser({ extensions: false });
    let baseline: PageProbe;
    try {
      baseline = await probe(plain.browser, `${srv.a}/index.html`);
    } finally {
      await plain.close();
    }

    const withExt = await launchBrowser();
    const mcp = await startClient(17839);
    try {
      await waitConnected(mcp.client);
      // An agent is busy in another tab while the user browses.
      await ok(mcp.client, 'tab_open', { url: `${srv.a}/page2.html` });
      await ok(mcp.client, 'page_snapshot');
      const touched = await probe(withExt.browser, `${srv.a}/index.html`);
      assert.deepEqual(touched.globals, baseline.globals, 'no globals added to the page');
      assert.equal(touched.html, baseline.html, 'identical DOM');
      assert.equal(touched.attrs, baseline.attrs);
      // Order of the cross-origin iframe's log and the browser's own favicon 404 vary run to run.
      const norm = (xs: string[]) => xs.filter((m) => !/Failed to load resource/.test(m)).sort();
      assert.deepEqual(norm(touched.console), norm(baseline.console), 'no extra console output');
      const diff = await pixelDiff(touched.screenshot, baseline.screenshot);
      assert.ok(diff < 0.001, `rendering identical (diff ${diff})`);
      const overhead = median(touched.loadMs) - median(baseline.loadMs);
      t.diagnostic(`load time median: ${median(touched.loadMs).toFixed(1)} ms with the extension vs ${median(baseline.loadMs).toFixed(1)} ms without (pixel diff ${diff})`);
      assert.ok(overhead < 60, `load time overhead ${overhead.toFixed(1)} ms (with ${median(touched.loadMs).toFixed(1)} vs without ${median(baseline.loadMs).toFixed(1)})`);
      const pages = await withExt.browser.pages();
      const userPage = pages.find((p) => p.url().endsWith('/index.html'));
      if (userPage) assert.ok(!(await attachedTabs(withExt.browser)).includes(await tabIdOf(withExt.browser, userPage)));
    } finally {
      await mcp.close();
      await withExt.close();
    }
  });

  it('cleans up everything when a session ends, without closing tabs', async () => {
    const bh = await launchBrowser();
    const mcp = await startClient(17838);
    try {
      await waitConnected(mcp.client);
      await ok(mcp.client, 'tab_open', { url: `${srv.a}/index.html` });
      await ok(mcp.client, 'emulate', { device: 'pixel-8', network: 'slow-3g', colorScheme: 'dark' });
      await ok(mcp.client, 'network_mock', { action: 'add', urlPattern: '*/api/echo', respond: { status: 503, body: 'mocked' } });
      await ok(mcp.client, 'wait_for', { timeMs: 200 });
      const page = (await bh.browser.pages()).find((p) => p.url().endsWith('/index.html'))!;
      const tabId = await tabIdOf(bh.browser, page);
      assert.ok((await attachedTabs(bh.browser)).includes(tabId));
      assert.equal(await page.evaluate(() => fetch('/api/echo').then((r) => r.status)), 503);
      await mcp.close();
      await sleep(2000);
      assert.deepEqual(await attachedTabs(bh.browser), [], 'debugger detached from every tab');
      assert.ok(!page.isClosed(), 'tab kept open');
      const state = await page.evaluate(async () => ({
        width: innerWidth,
        ua: navigator.userAgent,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        status: await fetch('/api/echo').then((r) => r.status),
        indicator: !!document.querySelector('neo-webmcp-indicator'),
      }));
      assert.notEqual(state.width, 412, 'device emulation removed');
      assert.doesNotMatch(state.ua, /Pixel 8/);
      assert.equal(state.status, 200, 'network mock removed');
      assert.equal(state.indicator, false, 'indicator removed');
    } finally {
      await bh.close();
    }
  });

  it('keeps concurrent sessions apart', async () => {
    const bh = await launchBrowser();
    const a = await startClient(17837, { name: 'agent-a' });
    const b = await startClient(17836, { name: 'agent-b' });
    try {
      await waitConnected(a.client);
      await waitConnected(b.client);
      await ok(a.client, 'tab_open', { url: `${srv.a}/index.html` });
      await ok(b.client, 'tab_open', { url: `${srv.a}/page2.html` });
      const list = await ok(a.client, 'tabs_list');
      assert.match(list.text, /Neo Test Shop.*group "agent-a"/);
      assert.match(list.text, /Second page.*group "agent-b"/);
      await ok(a.client, 'network_mock', { action: 'add', urlPattern: '*/api/echo', block: true });
      const inB = await ok(b.client, 'evaluate', { expression: 'fetch("/api/echo").then(r => r.status, () => "blocked")' });
      assert.match(inB.text, /200/, "agent-a's mock does not leak into agent-b's tab");
      const inA = await ok(a.client, 'evaluate', { expression: 'fetch("/api/echo").then(r => r.status, () => "blocked")' });
      assert.match(inA.text, /blocked/);
      await a.close();
      await sleep(1500);
      const still = await ok(b.client, 'page_info');
      assert.match(still.text, /Second page/);
      const attached = await attachedTabs(bh.browser);
      const pages = await bh.browser.pages();
      const tabA = await tabIdOf(bh.browser, pages.find((p) => p.url().endsWith('/index.html'))!);
      const tabB = await tabIdOf(bh.browser, pages.find((p) => p.url().endsWith('/page2.html'))!);
      assert.ok(attached.includes(tabB), "agent-b's tab stays attached");
      assert.ok(!attached.includes(tabA), "agent-a's tab was released when agent-a ended");
    } finally {
      await b.close();
      await bh.close();
    }
  });

  it('recovers when the extension service worker restarts', async (t) => {
    const bh = await launchBrowser();
    const mcp = await startClient(17835);
    try {
      await waitConnected(mcp.client);
      await ok(mcp.client, 'tab_open', { url: `${srv.a}/index.html` });
      await sleep(500); // Chrome stops an idle worker only after ~30 s
      const worker = await extensionWorker(bh.browser);
      await worker.close(); // stops the MV3 service worker like Chrome does when idle
      await sleep(500);
      // Waking it (any extension event) restarts it; the bridge waits for the reconnection.
      const page = (await bh.browser.pages()).find((p) => p.url().endsWith('/index.html'))!;
      await page.reload();
      const started = Date.now();
      const r = await call(mcp.client, 'page_info', {}, 60_000);
      assert.ok(!r.isError, r.text);
      assert.match(r.text, /Neo Test Shop/);
      t.diagnostic(`reconnected ${Date.now() - started} ms after the worker restarted`);
      assert.ok(Date.now() - started < 15_000, `reconnected in ${Date.now() - started} ms`);
      // The activity log from before the restart is still there, in the worker and in the side panel.
      const restarted = await extensionWorker(bh.browser);
      const log = await restarted.evaluate(async () => {
        const core = (globalThis as any).neoCore;
        await core.activity.ready;
        return core.activity.list().map((e: { tool: string; status: string }) => `${e.tool}:${e.status}`);
      });
      assert.ok(log.includes('tab_open:ok'), JSON.stringify(log));
      const panel = await bh.browser.newPage();
      await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
      await panel.waitForFunction(() => document.querySelector('#activity')?.textContent?.includes('tab_open'), { timeout: 10_000 });
      await panel.close();
    } finally {
      await mcp.close();
      await bh.close();
    }
  });

  it('reconnects when the MCP client (bridge) restarts', async () => {
    const bh = await launchBrowser();
    let mcp = await startClient(17834);
    try {
      await waitConnected(mcp.client);
      await mcp.close();
      await sleep(300);
      const started = Date.now();
      mcp = await startClient(17834);
      await waitConnected(mcp.client, 15_000);
      assert.ok(Date.now() - started < 10_000, `reconnected in ${Date.now() - started} ms`);
    } finally {
      await mcp.close();
      await bh.close();
    }
  });

  it('ends a running command with a clear error when the extension disconnects', async () => {
    const bh = await launchBrowser();
    const mcp = await startClient(17833);
    try {
      await waitConnected(mcp.client);
      await ok(mcp.client, 'tab_open', { url: `${srv.a}/index.html` });
      const started = Date.now();
      const running = call(mcp.client, 'wait_for', { timeMs: 20_000 }, 60_000);
      await sleep(1000);
      await (await extensionWorker(bh.browser)).close(); // the worker dies mid-command
      const r = await running;
      assert.ok(r.isError, r.text);
      assert.match(r.text, /The Neo WebMCP extension disconnected while the command was running/);
      assert.ok(Date.now() - started < 10_000, `ended after ${Date.now() - started} ms instead of hanging for 20 s`);
    } finally {
      await mcp.close();
      await bh.close();
    }
  });

  it('refuses connections that do not come from the extension', async () => {
    const bh = await launchBrowser();
    const mcp = await startClient(17832);
    const port = bridgePort(17832);
    try {
      await waitConnected(mcp.client);
      const page = await bh.browser.newPage();
      await page.goto(`${srv.a}/index.html`);
      const fromPage = await page.evaluate(
        (p) =>
          new Promise<string>((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${p}/neo-webmcp`);
            ws.onopen = () => resolve('open');
            ws.onerror = () => resolve('refused');
          }),
        port,
      );
      assert.equal(fromPage, 'refused', 'a web page cannot talk to the bridge');
      const url = `ws://127.0.0.1:${port}/neo-webmcp`;
      assert.match(await wsAttempt(url, { Origin: 'http://localhost:3000' }), /^refused 401/, 'a foreign origin is refused');
      assert.match(await wsAttempt(url, { Origin: EXTENSION_ORIGIN, Host: `evil.example:${port}` }), /^refused 401/, 'a foreign Host header (DNS rebinding) is refused');
      const lan = lanAddress();
      if (lan) assert.match(await wsAttempt(`ws://${lan}:${port}/neo-webmcp`, { Origin: EXTENSION_ORIGIN }), /^refused ECONNREFUSED/, 'not reachable from the network');
      const log = mcp.stderr.join('');
      assert.match(log, /rejected connection from origin=http:\/\/localhost:\d+ /, 'the bridge itself refused the page');
      assert.match(log, new RegExp(`rejected connection from origin=chrome-extension://\\S+ host=evil\\.example:${port}`));
      assert.match((await ok(mcp.client, 'browser_status')).text, /Extension: connected/, 'the real extension stays connected');
    } finally {
      await mcp.close();
      await bh.close();
    }
  });

  it('stays cheap while idle', async (t) => {
    const bh = await launchBrowser();
    try {
      const target = await bh.browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
      await extensionWorker(bh.browser);
      const session = await target.createCDPSession();
      // Service workers have no Performance domain: sample the CPU with the profiler instead.
      await session.send('Profiler.enable');
      await session.send('Profiler.setSamplingInterval', { interval: 1000 });
      await session.send('Profiler.start');
      await sleep(10_000); // no bridge running: the worker keeps looking for one
      const { profile } = await session.send('Profiler.stop');
      const idleIds = new Set(profile.nodes.filter((n) => ['(idle)', '(program)', '(root)'].includes(n.callFrame.functionName)).map((n) => n.id));
      let busyUs = 0;
      (profile.samples ?? []).forEach((id, i) => {
        if (!idleIds.has(id)) busyUs += profile.timeDeltas?.[i] ?? 0;
      });
      const heap = await session.send('Runtime.getHeapUsage');
      const heapMb = heap.usedSize / 1024 / 1024;
      t.diagnostic(`idle service worker over 10 s: ${(busyUs / 1000).toFixed(1)} ms CPU, ${heapMb.toFixed(1)} MB heap`);
      assert.ok(busyUs / 1000 < 300, `idle CPU over 10 s: ${(busyUs / 1000).toFixed(1)} ms`);
      assert.ok(heapMb < 15, `idle heap: ${heapMb.toFixed(1)} MB`);
    } finally {
      await bh.close();
    }
  });
});

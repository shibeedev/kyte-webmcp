/** Two-way DevTools: real DevTools window (headful), reveal element/source, read the user's selection, the "Neo MCP" panel inbox. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Frame, Page } from 'puppeteer-core';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { ARTIFACTS, call, launchBrowser, ok, sleep, startClient, waitConnected, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';

let srv: FixtureServers;
let bh: BrowserHandle;
let mcp: McpHandle;
let devtools: Page;

async function waitContext(pattern: RegExp, timeout = 15_000): Promise<string> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const r = await call(mcp.client, 'devtools_context');
    if (pattern.test(r.text)) return r.text;
    if (Date.now() > deadline) throw new Error(`devtools_context never matched ${pattern}: ${r.text}`);
    await sleep(250);
  }
}

async function panelFrame(): Promise<Frame> {
  for (let i = 0; i < 60; i++) {
    const frame = devtools.frames().find((f) => f.url().includes('/panel.html'));
    if (frame) return frame;
    await sleep(250);
  }
  throw new Error('Neo MCP panel frame not found');
}

describe('two-way DevTools', () => {
  before(async () => {
    srv = await startFixtureServers();
    bh = await launchBrowser({ devtools: true, args: ['--window-size=1920,1080'] });
    mcp = await startClient(17833);
    await waitConnected(mcp.client);
    // DevTools must open after the extension is installed (Chrome loads extension DevTools pages on open),
    // so use a new tab and close the initial one: exactly one DevTools window remains.
    await ok(mcp.client, 'tab_open', { url: `${srv.a}/index.html` });
    for (const p of await bh.browser.pages()) if (p.url() === 'about:blank') await p.close();
    await sleep(500);
    const target = await bh.browser.waitForTarget((t) => t.url().startsWith('devtools://') && t.type() !== 'service_worker', { timeout: 20_000 });
    devtools = (await target.asPage())!;
  });
  after(async () => {
    await mcp?.close();
    await bh?.close();
    await srv?.close();
  });

  it('knows when DevTools is open and reveals elements in the Elements panel', async () => {
    await waitContext(/No element is selected|Selected in the Elements panel/);
    const r = await ok(mcp.client, 'devtools_reveal', { selector: '#email' });
    assert.match(r.text, /Showing #email in the user's DevTools Elements panel/);
    const ctx = await waitContext(/<input#email> selector #email/);
    assert.match(ctx, /Selected in the Elements panel → \[ref=e\d+\]/);
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    const heading = await ok(mcp.client, 'find', { text: 'Neo Test Shop' });
    void snap;
    await ok(mcp.client, 'devtools_reveal', { ref: heading.text.match(/\[ref=(e\d+)\]/)![1]! });
    await waitContext(/<h1> selector/);
  });

  it('opens a source file at a line in the Sources panel', async () => {
    const r = await ok(mcp.client, 'devtools_reveal', { url: `${srv.a}/index.html`, line: 40 });
    assert.match(r.text, /Opened .*index\.html:40 in the user's DevTools Sources panel/);
  });

  it('lets the user share the selected element and a request from the Neo MCP panel', async () => {
    await ok(mcp.client, 'devtools_reveal', { selector: '#fetchBtn' });
    await waitContext(/<button#fetchBtn>/);
    // Dock DevTools at the bottom (Ctrl+Shift+D) so the tab strip is wide enough to show the extension's tab, then click it.
    await devtools.bringToFront();
    await devtools.keyboard.down('Control');
    await devtools.keyboard.down('Shift');
    await devtools.keyboard.press('KeyD');
    await devtools.keyboard.up('Shift');
    await devtools.keyboard.up('Control');
    await sleep(1200);
    const tab = await devtools.waitForSelector('::-p-aria([name="Neo MCP"][role="tab"])', { timeout: 10_000 });
    await tab!.click();
    const frame = await panelFrame();
    await frame.waitForFunction(() => document.getElementById('selection')?.textContent?.includes('fetchBtn'), { timeout: 10_000 });
    await frame.type('#note', 'Why does this call fail?');
    await frame.click('#send-element');
    const shared = await waitContext(/element #fetchBtn.*note: "Why does this call fail\?"/);
    assert.match(shared, /Shared by the user from the Neo MCP DevTools panel \(1\)/);
    // A request made while DevTools is open shows up in the panel and can be shared too.
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    await ok(mcp.client, 'click', { ref: snap.text.match(/button "Call API" \[ref=(e\d+)\]/)![1]! });
    await frame.waitForFunction(() => Array.from(document.querySelectorAll('#requests td.url')).some((td) => td.textContent?.includes('/api/echo')), { timeout: 10_000 });
    await frame.evaluate(() => {
      const row = Array.from(document.querySelectorAll('#requests tr')).find((tr) => tr.textContent?.includes('/api/echo'))!;
      (row.querySelector('button') as HTMLButtonElement).click();
    });
    const both = await waitContext(/request POST 200 http:\/\/localhost:\d+\/api\/echo/);
    assert.match(both, /response excerpt: \{"method":"POST"/);
    await devtools.screenshot({ path: path.join(ARTIFACTS, 'ui', 'devtools-panel.png') });
    const cleared = await ok(mcp.client, 'devtools_context', { clearInbox: true });
    assert.match(cleared.text, /\(2\)/);
    assert.match((await ok(mcp.client, 'devtools_context')).text, /has not shared anything/);
  });
});

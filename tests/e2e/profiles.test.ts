/**
 * Several Chrome profiles: two real profiles in one Chrome for Testing, each running the extension. Every MCP
 * client stays with one profile (pinned with --profile, or the first profile that connected), the master switch
 * turns a profile's connections off, and each profile's LAN endpoint is its own. Opens visible windows (a second
 * profile needs one). Screenshots go to tests/.artifacts/ui.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { ARTIFACTS, CLI, TEST_ENV, call, extensionWorker, launchBrowser, ok, sleep, startClient, waitConnected, type McpHandle } from '../helpers/harness.ts';
import { launchTwoProfiles, type ProfileHandle, type TwoProfiles } from '../helpers/profiles.ts';
import { LAN_PATH, LAN_PORT } from '../../src/shared/constants.ts';

const SHOTS = path.join(ARTIFACTS, 'ui');
mkdirSync(SHOTS, { recursive: true });
const LAN_TEST_PORT = LAN_PORT + 100;

async function waitFor(check: () => Promise<boolean>, what: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function waitText(page: Page, selector: string, pattern: RegExp, timeout = 10_000): Promise<string> {
  let text = '';
  await waitFor(
    async () => pattern.test((text = await page.$eval(selector, (el) => (el as HTMLElement).innerText).catch(() => ''))),
    `${selector} to match ${pattern} (last: ${text.slice(0, 200)})`,
    timeout,
  );
  return text;
}

const hasSession = async (p: ProfileHandle, name: string) => (await p.sessions()).some((s) => s.startsWith(name));

const setName = async (p: ProfileHandle, name: string) => (await p.worker()).evaluate((n: string) => (globalThis as any).kyteCore.settings.update({ profileName: n }), name);

function cli(command: string): string {
  return execFileSync(process.execPath, [CLI, command], { env: { ...process.env, ...TEST_ENV }, encoding: 'utf8' });
}

describe('several Chrome profiles in one browser', () => {
  let srv: FixtureServers;
  let browser: TwoProfiles;
  let work: ProfileHandle;
  let home: ProfileHandle;
  const clients: Array<{ close(): Promise<void> }> = [];
  let pinnedWork: McpHandle;
  let pinnedHome: McpHandle;
  let workPanel: Page;

  before(async () => {
    srv = await startFixtureServers();
    browser = await launchTwoProfiles();
    [work, home] = browser.profiles;
    await setName(work, 'Work');
    await setName(home, 'Home');
  });
  after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await browser?.close();
    await srv?.close();
    cli('uninstall');
  });

  it('an MCP client without --profile stays with the first profile that took it, even while that profile sleeps', async (t) => {
    const mcp = await startClient(17831, { name: 'kyte-unpinned' });
    clients.push(mcp);
    await waitConnected(mcp.client);
    const [owner, other] = (await hasSession(work, 'kyte-unpinned')) ? [work, home] : [home, work];
    assert.equal(await hasSession(other, 'kyte-unpinned'), false, 'only one profile has the session');
    t.diagnostic(`taken by ${owner.label}`);
    assert.match((await ok(mcp.client, 'browser_status')).text, new RegExp(`Chrome profile: Chrome profile "${owner === work ? 'Work' : 'Home'}" \\(the first profile that connected`));
    // Chrome stops an idle service worker; before, the other profile grabbed the bridge in that gap.
    await (await owner.worker()).close();
    const gap = Date.now();
    while (Date.now() - gap < 14_000) {
      assert.equal(await hasSession(other, 'kyte-unpinned'), false, `${other.label} must not take the client`);
      await sleep(1000);
    }
    await owner.navigate(`${srv.a}/page2.html`); // wakes the owner's worker
    await waitFor(() => hasSession(owner, 'kyte-unpinned'), 'the owner to reconnect');
    assert.match((await ok(mcp.client, 'tabs_list')).text, /Second page/);
    await mcp.close();
    clients.splice(clients.indexOf(mcp), 1);
  });

  it('clients pinned with --profile each get their own profile, whichever profile asks first', async () => {
    pinnedWork = await startClient(17832, { name: 'kyte-work', env: { KYTE_WEBMCP_PROFILE: 'Work' } });
    pinnedHome = await startClient(17833, { name: 'kyte-home', env: { KYTE_WEBMCP_PROFILE: 'home' } }); // names match without regard to case
    clients.push(pinnedWork, pinnedHome);
    await waitConnected(pinnedWork.client);
    await waitConnected(pinnedHome.client);
    assert.deepEqual((await work.sessions()).sort(), ['kyte-work']);
    assert.deepEqual((await home.sessions()).sort(), ['kyte-home']);
    assert.match((await ok(pinnedWork.client, 'browser_status')).text, /Chrome profile: Chrome profile "Work" \(pinned with --profile\)/);
    // Tabs open in the client's own profile.
    await ok(pinnedWork.client, 'tab_open', { url: `${srv.a}/index.html#work` });
    await ok(pinnedHome.client, 'tab_open', { url: `${srv.a}/index.html#home` });
    const [workTabs, homeTabs] = [await work.tabUrls(), await home.tabUrls()];
    assert.ok(workTabs.some((u) => u.endsWith('#work')) && !workTabs.some((u) => u.endsWith('#home')), JSON.stringify(workTabs));
    assert.ok(homeTabs.some((u) => u.endsWith('#home')) && !homeTabs.some((u) => u.endsWith('#work')), JSON.stringify(homeTabs));
  });

  it('a client pinned to a profile that does not exist never connects, and says why', async () => {
    const lost = await startClient(17834, { name: 'kyte-lost', env: { KYTE_WEBMCP_PROFILE: 'Nowhere' } });
    clients.push(lost);
    await sleep(6000);
    const status = (await call(lost.client, 'browser_status')).text;
    assert.match(status, /Extension: NOT connected/);
    assert.match(status, /Chrome profile "Nowhere" \(pinned with --profile\)/);
    assert.equal(await hasSession(work, 'kyte-lost'), false);
    assert.equal(await hasSession(home, 'kyte-lost'), false);
    await lost.close();
    clients.splice(clients.indexOf(lost), 1);
  });

  it('renaming a profile in its side panel moves the pinned clients with the name', async () => {
    const panel = await home.sidePanel();
    assert.equal(await panel.$eval('#set-profile-name', (el) => (el as HTMLInputElement).value), 'Home');
    assert.match(await panel.$eval('#cmd-claude', (el) => el.textContent ?? ''), /^claude mcp add kyte-webmcp-home -- node ".+cli\.mjs" --profile "Home"$/);
    assert.match(await panel.$eval('#profile-note', (el) => el.textContent ?? ''), /only to this Chrome profile \("Home"\)/);
    await panel.click('#set-profile-name', { count: 3 });
    await panel.keyboard.type('Personal');
    await panel.keyboard.press('Enter');
    await waitFor(async () => !(await hasSession(home, 'kyte-home')), 'the client pinned to "Home" to leave');
    assert.match(await waitText(panel, '#cmd-claude', /Personal/), /kyte-webmcp-personal -- node .+ --profile "Personal"/);
    const personal = await startClient(17834, { name: 'kyte-personal', env: { KYTE_WEBMCP_PROFILE: 'Personal' } });
    clients.push(personal);
    await waitConnected(personal.client);
    assert.equal(await hasSession(home, 'kyte-personal'), true);
    // Back to "Home": the first client comes back, the "Personal" one leaves.
    await setName(home, 'Home');
    await waitFor(() => hasSession(home, 'kyte-home'), 'the client pinned to "Home" to come back', 25_000);
    await waitFor(async () => !(await hasSession(home, 'kyte-personal')), 'the "Personal" client to leave');
    await personal.close();
    clients.splice(clients.indexOf(personal), 1);
    await panel.close();
  });

  it('the master switch turns one profile off; unpinned clients move to the other profile, pinned ones wait', async () => {
    const roaming = await startClient(17835, { name: 'kyte-roaming' });
    clients.push(roaming);
    await waitConnected(roaming.client);
    const ownerIsWork = await hasSession(work, 'kyte-roaming');
    const [owner, other] = ownerIsWork ? [work, home] : [home, work];
    const panel = await owner.sidePanel();
    if (owner === work) workPanel = panel;
    assert.equal(await panel.$eval('#set-enabled', (el) => (el as HTMLInputElement).checked), true);
    await panel.click('#set-enabled');
    await waitText(panel, '#status', /Connections off/);
    await waitText(panel, '#no-sessions', /Connections are off for this Chrome profile/);
    assert.deepEqual(await owner.sessions(), []);
    assert.equal(await (await owner.worker()).evaluate(() => chrome.action.getBadgeText({})), 'OFF');
    await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-connections-off-en.png'), fullPage: true });
    // The client that was only bound to this profile moves on; the one pinned to it waits.
    await waitFor(() => hasSession(other, 'kyte-roaming'), 'the unpinned client to move to the other profile', 25_000);
    const pinnedToOwner = owner === work ? pinnedWork : pinnedHome;
    assert.match((await call(pinnedToOwner.client, 'browser_status')).text, /Extension: NOT connected[\s\S]*connection switch must be on/);
    // Off is remembered across a service worker restart.
    await (await owner.worker()).close();
    await owner.navigate(`${srv.a}/page2.html#wake`);
    await sleep(4000);
    assert.deepEqual(await owner.sessions(), []);
    // On again: the pinned client returns; the moved one stays where it is now.
    await panel.click('#set-enabled');
    await waitText(panel, '#status', /Connected sessions: 1/, 20_000);
    assert.equal(await hasSession(owner, pinnedToOwner === pinnedWork ? 'kyte-work' : 'kyte-home'), true);
    assert.equal(await hasSession(other, 'kyte-roaming'), true);
    if (owner !== work) await panel.close();
  });

  it('each profile runs its own LAN endpoint on its own port, and the master switch closes only that one', async (t) => {
    cli('install');
    for (const p of [work, home]) await (await p.worker()).evaluate(() => (globalThis as any).kyteCore.settings.update({ lan: true }));
    const view = async (p: ProfileHandle) => (await p.worker()).evaluate(() => (globalThis as any).kyteCore.lan.view());
    await waitFor(async () => (await view(work)).state === 'on' && (await view(home)).state === 'on', 'both LAN endpoints', 20_000);
    const [w, h] = [await view(work), await view(home)];
    t.diagnostic(`Work on ${w.port}, Home on ${h.port}`);
    assert.notEqual(w.port, h.port);
    for (const port of [w.port, h.port]) assert.ok(port >= LAN_TEST_PORT && port < LAN_TEST_PORT + 10, String(port));
    const lanClient = async (port: number, token: string, name: string) => {
      const client = new Client({ name, version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${LAN_PATH}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      clients.push(client);
      return client;
    };
    const lanWork = await lanClient(w.port, w.token, 'lan-work');
    const lanHome = await lanClient(h.port, h.token, 'lan-home');
    await waitConnected(lanWork, 20_000);
    await waitConnected(lanHome, 20_000);
    assert.equal(await hasSession(work, 'lan-work @ '), true);
    assert.equal(await hasSession(home, 'lan-home @ '), true);
    await ok(lanHome, 'tab_open', { url: `${srv.a}/index.html#lan-home` });
    assert.ok((await home.tabUrls()).some((u) => u.endsWith('#lan-home')));
    assert.ok(!(await work.tabUrls()).some((u) => u.endsWith('#lan-home')));
    // Each profile keeps its port across a restart of its LAN host.
    for (const p of [work, home]) await (await p.worker()).evaluate(() => (globalThis as any).kyteCore.settings.update({ lan: false }));
    for (const p of [home, work]) await (await p.worker()).evaluate(() => (globalThis as any).kyteCore.settings.update({ lan: true }));
    await waitFor(async () => (await view(work)).state === 'on' && (await view(home)).state === 'on', 'both LAN endpoints again', 20_000);
    assert.deepEqual([(await view(work)).port, (await view(home)).port], [w.port, h.port]);
    // Master switch off in Work: Work's LAN port closes, Home's keeps serving.
    const panel = workPanel ?? (await work.sidePanel());
    await panel.click('#set-enabled');
    await waitText(panel, '#lan-state', /Connections are off for this profile/);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${w.port}${LAN_PATH}`, { method: 'POST' }).then(() => 'open', () => 'closed')) === 'closed', "Work's LAN port to close");
    const homeAgain = await lanClient(h.port, h.token, 'lan-home-2');
    await waitConnected(homeAgain, 20_000);
    assert.equal(await hasSession(home, 'lan-home-2 @ '), true);
    await panel.click('#set-enabled');
    await waitFor(async () => (await view(work)).state === 'on', "Work's LAN endpoint to come back", 20_000);
    assert.equal((await view(work)).port, w.port);
  });
});

describe('profile name and master switch (Vietnamese)', () => {
  it('shows the switch, the off state and the profile name in Vietnamese', async () => {
    const bh = await launchBrowser({ lang: 'vi' });
    try {
      const sw = await extensionWorker(bh.browser);
      await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', width: 420, height: 900 }));
      const target = await bh.browser.waitForTarget((t) => t.url().endsWith('/sidepanel.html'));
      const panel = (await target.page())!;
      await panel.setViewport({ width: 400, height: 1300 });
      await panel.waitForFunction(() => document.getElementById('status-text')?.textContent !== '');
      assert.equal(await panel.$eval('#set-enabled', (el) => el.getAttribute('aria-label')), 'Cho MCP client kết nối vào profile Chrome này');
      assert.match(await panel.$eval('#set-profile-name', (el) => (el.closest('label') as HTMLElement).innerText), /Tên của profile Chrome này/);
      assert.match(await panel.$eval('#profile-note', (el) => el.textContent ?? ''), /chỉ kết nối vào profile Chrome này/);
      await panel.click('#set-enabled');
      await waitText(panel, '#status', /Đã tắt kết nối/);
      await waitText(panel, '#no-sessions', /Profile Chrome này đang tắt kết nối/);
      await waitText(panel, '#lan-state', /Profile này đang tắt kết nối/);
      await panel.screenshot({ path: path.join(SHOTS, 'sidepanel-connections-off-vi.png'), fullPage: true });
    } finally {
      await bh.close();
    }
  });
});

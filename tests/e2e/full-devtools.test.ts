/**
 * Full DevTools channel: Chrome runs with a non-default profile and remote debugging (like `neo-webmcp chrome`),
 * so the shared broker connects without any prompt and unlocks domains extensions cannot use.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { ARTIFACTS, CHROME, CLI, call, lanAddress, launchBrowser, ok, sleep, startClient, waitConnected, wsAttempt, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';

let srv: FixtureServers;
let bh: BrowserHandle;
let mcp: McpHandle;
let mcp2: McpHandle | undefined;
const brokerFile = path.join(ARTIFACTS, 'state', 'broker.json');

describe('full devtools channel', () => {
  before(async () => {
    srv = await startFixtureServers();
    bh = await launchBrowser({ args: ['--remote-debugging-port=0'] });
    mcp = await startClient(17835, { env: { NEO_WEBMCP_CHROME_USER_DATA_DIR: bh.userDataDir } });
    await waitConnected(mcp.client);
    await ok(mcp.client, 'tab_open', { url: `${srv.a}/perf.html` });
  });
  after(async () => {
    await mcp2?.close();
    await mcp?.close();
    await bh?.close();
    await srv?.close();
  });

  it('leaves a broker running when no browser is found (started by a bridge with no endpoint settings)', async () => {
    const plain = await startClient(17833, { name: 'no-endpoint-client' });
    try {
      await waitConnected(plain.client);
      const r = await call(plain.client, 'cdp_send', { method: 'Memory.getDOMCounters' }, 60_000);
      assert.ok(r.isError, r.text);
      assert.match(r.text, /no browser with remote debugging enabled was found/);
      assert.ok(existsSync(brokerFile), 'the broker keeps running for other bridges');
    } finally {
      await plain.close();
    }
  });

  it('starts idle and connects on first use', async () => {
    const reused = JSON.parse(readFileSync(brokerFile, 'utf8')) as { pid: number };
    assert.match((await ok(mcp.client, 'browser_status')).text, /Full DevTools channel: idle — connects automatically/);
    const counters = await ok(mcp.client, 'cdp_send', { method: 'Memory.getDOMCounters' });
    assert.match(counters.text, /\(via full DevTools channel\)[\s\S]*"jsEventListeners"/);
    assert.match((await ok(mcp.client, 'browser_status')).text, /Full DevTools channel: connected via .*neo-webmcp-test-/);
    assert.equal((JSON.parse(readFileSync(brokerFile, 'utf8')) as { pid: number }).pid, reused.pid, "the running broker was reused with this bridge's endpoint settings");
  });

  it('takes and summarizes a heap snapshot', async () => {
    const r = await ok(mcp.client, 'memory', { action: 'snapshot' }, 180_000);
    const file = r.text.match(/saved to (.+\.heapsnapshot)/)![1]!;
    assert.ok(existsSync(file));
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).snapshot.meta.node_fields.includes('self_size'));
    assert.match(r.text, /\d[\d,.]* objects, .* total self size/);
    assert.match(r.text, /Largest classes by self size:\n {2}- /);
  });

  it('measures JavaScript coverage', async () => {
    await ok(mcp.client, 'coverage', { action: 'start', types: ['js', 'css'], reload: true });
    await sleep(1500);
    const r = await ok(mcp.client, 'coverage', { action: 'stop' });
    assert.match(r.text, /JS .* unused of .*perf-blocking\.js/);
    assert.match(r.text, /CSS .* unused of .*perf\.css/);
    assert.doesNotMatch(r.text, /JavaScript coverage (unavailable|failed)/);
  });

  it('shows codec details from the DevTools Media panel', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/video.html` });
    await sleep(800);
    await ok(mcp.client, 'video_control', { action: 'play' });
    await sleep(800);
    const r = await ok(mcp.client, 'media_inspect', {});
    assert.match(r.text, /Media panel \(full DevTools channel\): video h264 \(h264 high\) 640[x×]360 · video decoder \S+.* · audio aac mono 44100 Hz/);
    await ok(mcp.client, 'video_control', { action: 'pause' });
  });

  it('shares one browser connection between bridges', async () => {
    const before = JSON.parse(readFileSync(brokerFile, 'utf8')) as { pid: number };
    mcp2 = await startClient(17834, { env: { NEO_WEBMCP_CHROME_USER_DATA_DIR: bh.userDataDir }, name: 'second-client' });
    await waitConnected(mcp2.client);
    const r = await ok(mcp2.client, 'cdp_send', { method: 'Memory.getDOMCounters' });
    assert.match(r.text, /via full DevTools channel/);
    const afterInfo = JSON.parse(readFileSync(brokerFile, 'utf8')) as { pid: number };
    assert.equal(afterInfo.pid, before.pid, 'the second bridge reused the running broker');
  });

  it('accepts only authenticated bridges on this machine', async () => {
    const info = JSON.parse(readFileSync(brokerFile, 'utf8')) as { port: number; token: string };
    const url = `ws://127.0.0.1:${info.port}/neo-webmcp-broker`;
    assert.match(await wsAttempt(url), /^refused 401/, 'no token');
    assert.match(await wsAttempt(url, { Authorization: 'Bearer wrong' }), /^refused 401/, 'wrong token');
    assert.equal(await wsAttempt(url, { Authorization: `Bearer ${info.token}` }), 'open', 'the right token is accepted');
    const lan = lanAddress();
    if (lan) assert.match(await wsAttempt(`ws://${lan}:${info.port}/neo-webmcp-broker`, { Authorization: `Bearer ${info.token}` }), /^refused ECONNREFUSED/, 'not reachable from the network');
  });
});

describe('neo-webmcp chrome (dedicated agent profile)', () => {
  const profile = path.join(ARTIFACTS, 'agent-profile');
  let client: McpHandle | undefined;

  const killAgentChrome = () => {
    if (process.platform !== 'win32') return;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*agent-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { timeout: 30_000 });
  };

  after(async () => {
    await client?.close();
    killAgentChrome();
  });

  it('starts Chrome with its own profile and the extension, and gives full DevTools without prompts', async () => {
    rmSync(profile, { recursive: true, force: true });
    const run = spawnSync(process.execPath, [CLI, 'chrome', '--chrome-path', CHROME, '--profile-dir', profile, '--url', 'about:blank'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Agent Chrome is running with profile .*agent-profile/);
    assert.match(run.stderr, /The Neo WebMCP extension is loaded in this profile/);
    client = await startClient(17832, { env: { NEO_WEBMCP_CHROME_USER_DATA_DIR: profile }, name: 'agent-profile-client' });
    await waitConnected(client.client, 30_000);
    const r = await ok(client.client, 'cdp_send', { method: 'Memory.getDOMCounters' });
    assert.match(r.text, /via full DevTools channel/);
    assert.match((await ok(client.client, 'browser_status')).text, /Full DevTools channel: connected via .*agent-profile/);
  });
});

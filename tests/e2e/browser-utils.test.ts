/** Browser utilities (downloads, history, bookmarks, clipboard, PDF) and MCP prompts. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { ARTIFACTS, call, launchBrowser, ok, startClient, waitConnected, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';

let srv: FixtureServers;
let bh: BrowserHandle;
let mcp: McpHandle;
const downloadDir = path.join(ARTIFACTS, 'downloads');

/** Hash of the user's real system clipboard text (never printed), to prove tests leave it alone. */
function systemClipboardHash(): string {
  if (process.platform !== 'win32') return 'n/a';
  try {
    const text = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8', timeout: 15_000 });
    return createHash('sha256').update(text).digest('hex');
  } catch {
    return 'unreadable';
  }
}

describe('browser utilities and prompts', () => {
  before(async () => {
    mkdirSync(downloadDir, { recursive: true });
    srv = await startFixtureServers();
    // Keep test downloads out of the user's Downloads folder.
    bh = await launchBrowser({ downloadDir });
    mcp = await startClient(17831);
    await waitConnected(mcp.client);
    await ok(mcp.client, 'tab_open', { url: `${srv.a}/index.html` });
  });
  after(async () => {
    await mcp?.close();
    await bh?.close();
    await srv?.close();
  });

  it('downloads a file and waits for it', async () => {
    const started = await ok(mcp.client, 'downloads', { action: 'download', url: `${srv.a}/media/sample.vtt`, filename: 'neo-test-captions.vtt' });
    const id = Number(started.text.match(/#(\d+)/)![1]);
    const done = await ok(mcp.client, 'downloads', { action: 'wait', id, timeoutMs: 20_000 });
    assert.match(done.text, /Download finished: #\d+ complete .*neo-test-captions.*\.vtt/);
    const file = done.text.match(/complete (.+?\.vtt)/)![1]!;
    assert.ok(file.startsWith(downloadDir), `saved inside the test folder, not the user's Downloads: ${file}`);
    assert.match(readFileSync(file, 'utf8'), /^WEBVTT/);
    assert.match((await ok(mcp.client, 'downloads', { action: 'list' })).text, /neo-test-captions/);
  });

  it('searches history', async () => {
    const r = await ok(mcp.client, 'history_search', { text: 'Neo Test Shop' });
    assert.match(r.text, /Neo Test Shop — http:\/\/localhost:\d+\/index\.html/);
  });

  it('creates, finds and removes bookmarks', async () => {
    const created = await ok(mcp.client, 'bookmarks', { action: 'create', title: 'Neo bookmark test', url: `${srv.a}/page2.html` });
    const id = created.text.match(/\[(\d+)\]/)![1]!;
    assert.match((await ok(mcp.client, 'bookmarks', { action: 'search', query: 'Neo bookmark test' })).text, new RegExp(`\\[${id}\\] Neo bookmark test`));
    await ok(mcp.client, 'bookmarks', { action: 'remove', id });
    assert.match((await ok(mcp.client, 'bookmarks', { action: 'search', query: 'Neo bookmark test' })).text, /No bookmarks match/);
  });

  it('writes and reads the clipboard without touching the system clipboard', async () => {
    const before = systemClipboardHash();
    await ok(mcp.client, 'clipboard', { action: 'write', text: 'hello from neo webmcp' });
    const read = await ok(mcp.client, 'clipboard', { action: 'read' });
    assert.match(read.text, /hello from neo webmcp/);
    assert.equal(systemClipboardHash(), before, 'headless test browser must not overwrite the real clipboard');
  });

  it('saves the page as PDF', async () => {
    const target = path.join(ARTIFACTS, 'output', 'neo-test-page.pdf');
    const r = await ok(mcp.client, 'pdf_save', { savePath: target });
    assert.match(r.text, /Saved "Neo Test Shop" as PDF to .*neo-test-page\.pdf/);
    assert.ok(existsSync(target));
    assert.equal(readFileSync(target).subarray(0, 5).toString(), '%PDF-');
  });

  it('serves workflow prompts', async () => {
    const { prompts } = await mcp.client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ['agent_readiness', 'audit_performance', 'debug_page', 'test_webmcp_tools', 'watch_video']);
    const p = await mcp.client.getPrompt({ name: 'watch_video', arguments: { url: 'https://example.com/v', question: 'What colours appear?' } });
    const text = (p.messages[0]!.content as { text: string }).text;
    assert.match(text, /Open https:\/\/example\.com\/v with tab_open/);
    assert.match(text, /video_watch/);
    assert.match(text, /What colours appear\?/);
    const debugText = async (args: Record<string, string>) => ((await mcp.client.getPrompt({ name: 'debug_page', arguments: args })).messages[0]!.content as { text: string }).text;
    assert.match(await debugText({}), /reload with navigate/);
    assert.doesNotMatch(await debugText({ url: 'https://example.com/' }), /reload with navigate/, 'a tab opened with tab_open is recorded from the start');
  });

  it('rejects invalid arguments with a helpful message', async () => {
    const r = await call(mcp.client, 'click', { ref: 12 });
    assert.ok(r.isError);
    assert.match(r.text, /Invalid arguments for click: args\.ref must be string/);
    const unknown = await call(mcp.client, 'navigate', { url: 'x', bogus: true });
    assert.match(unknown.text, /args\.bogus is not a known parameter/);
  });

  it('asks the user to open DevTools before revealing something in it', async () => {
    const r = await call(mcp.client, 'devtools_reveal', { selector: 'body' });
    assert.ok(r.isError, r.text);
    assert.match(r.text, /DevTools is not open on this tab\. Ask the user to open DevTools \(F12\)/);
  });
});

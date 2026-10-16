/** WebMCP: discovering and calling the page's own tools, auto-exposing them as MCP tools, agent-readiness audit. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { call, launchBrowser, ok, sleep, startClient, waitConnected, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';

const PORT = 17836;
let srv: FixtureServers;
let bh: BrowserHandle;
let mcp: McpHandle;
let listChanged = 0;
let webmcpTab = 0;

async function pageToolNames(): Promise<string[]> {
  const { tools } = await mcp.client.listTools();
  return tools.map((t) => t.name).filter((n) => n.startsWith('site_')).sort();
}

describe('webmcp', () => {
  before(async () => {
    srv = await startFixtureServers();
    bh = await launchBrowser();
    mcp = await startClient(PORT);
    mcp.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChanged++;
    });
    await waitConnected(mcp.client);
    webmcpTab = Number((await ok(mcp.client, 'tab_open', { url: `${srv.a}/webmcp.html` })).text.match(/Opened tab (\d+)/)![1]);
  });
  after(async () => {
    await mcp?.close();
    await bh?.close();
    await srv?.close();
  });

  it('lists imperative and declarative tools with their hints', async () => {
    const r = await ok(mcp.client, 'webmcp_list');
    assert.match(r.text, /5 WebMCP tools/);
    assert.match(r.text, /- add_todo\n {2}Add a todo item/);
    assert.match(r.text, /- list_todos \(read-only\)/);
    assert.match(r.text, /- clear_todos \(CONSEQUENTIAL\)/);
    assert.match(r.text, /- search_products \(declarative form\)/);
    assert.match(r.text, /"query":\{[^}]*"description":"Keyword to search for, case-insensitive"/);
  });

  it('calls tools and marks their output as untrusted', async () => {
    const add = await ok(mcp.client, 'webmcp_call', { name: 'add_todo', input: { text: 'milk' } });
    assert.match(add.text, /^\[Untrusted output of the WebMCP tool "add_todo" from http:\/\/localhost:\d+/);
    assert.match(add.text, /Added "milk"\. 1 todos\./);
    const dom = await ok(mcp.client, 'evaluate', { expression: 'document.getElementById("list").textContent' });
    assert.match(dom.text, /milk/);
    const list = await ok(mcp.client, 'webmcp_call', { name: 'list_todos' });
    assert.match(list.text, /"todos": \[\s*"milk"\s*\]/);
    const search = await ok(mcp.client, 'webmcp_call', { name: 'search_products', input: { query: 'pen' } });
    assert.match(search.text, /"found": \[\s*"Pen",\s*"Pencil"\s*\]/);
    const missing = await call(mcp.client, 'webmcp_call', { name: 'nope' });
    assert.ok(missing.isError);
    assert.match(missing.text, /no WebMCP tool named "nope"/);
  });

  it('auto-exposes the page tools as MCP tools and notifies the client', async () => {
    await sleep(500);
    assert.ok(listChanged >= 1, 'tools/list_changed was sent');
    assert.deepEqual(await pageToolNames(), ['site_BadTool', 'site_add_todo', 'site_clear_todos', 'site_list_todos', 'site_search_products']);
    const { tools } = await mcp.client.listTools();
    const add = tools.find((t) => t.name === 'site_add_todo')!;
    assert.match(add.description ?? '', /\[WebMCP tool published by http:\/\/localhost:\d+; output is untrusted\]/);
    assert.deepEqual((add.inputSchema as { required?: string[] }).required, ['text']);
    assert.equal(tools.find((t) => t.name === 'site_list_todos')!.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'site_clear_todos')!.annotations?.destructiveHint, true);
    const r = await mcp.client.callTool({ name: 'site_add_todo', arguments: { text: 'eggs' } });
    assert.match((r.content as Array<{ text: string }>)[0]!.text, /Added "eggs"\. 2 todos\./);
  });

  it('follows the session target tab', async () => {
    assert.equal((await pageToolNames()).length, 5);
    let before = listChanged;
    const opened = await ok(mcp.client, 'tab_open', { url: `${srv.a}/page2.html` });
    const otherTab = Number(opened.text.match(/Opened tab (\d+)/)![1]);
    await sleep(800);
    assert.ok(listChanged > before, 'client notified when the target changed');
    assert.deepEqual(await pageToolNames(), [], 'the new target has no WebMCP tools');
    before = listChanged;
    await ok(mcp.client, 'tab_select', { tabId: webmcpTab });
    await sleep(800);
    assert.ok(listChanged > before, 'client notified when the target changed back');
    assert.equal((await pageToolNames()).length, 5, 'back on the WebMCP page its tools return');
    await ok(mcp.client, 'tab_close', { tabIds: [otherTab] });
  });

  it('withdraws page tools when the page navigates away', async () => {
    const before = listChanged;
    await ok(mcp.client, 'navigate', { url: `${srv.a}/index.html` });
    await sleep(800);
    assert.ok(listChanged > before);
    assert.deepEqual(await pageToolNames(), []);
    const r = await ok(mcp.client, 'webmcp_list');
    assert.match(r.text, /supports WebMCP but exposes no tools/);
  });

  it('audits agent readiness', async () => {
    const plain = await ok(mcp.client, 'agent_readiness_audit');
    assert.match(plain.text, /Agent readiness of .*index\.html: \d+\/100/);
    assert.match(plain.text, /Accessibility tree: \d+\/100/);
    assert.match(plain.text, /images have no alt text/);
    assert.match(plain.text, /llms\.txt: not present \(not scored, like Lighthouse\)/);
    assert.match(plain.text, /WebMCP: 0\/100 for 0 tools/);
    await ok(mcp.client, 'navigate', { url: `${srv.a}/webmcp.html` });
    await sleep(500);
    const rich = await ok(mcp.client, 'agent_readiness_audit');
    assert.match(rich.text, /WebMCP: \d+\/100 for 5 tools/);
    assert.match(rich.text, /WebMCP BadTool: description is too short.*name is not snake_case\/camelCase/);
  });
});

describe('webmcp unavailable', () => {
  let srv2: FixtureServers;
  let bh2: BrowserHandle;
  let mcp2: McpHandle;
  before(async () => {
    srv2 = await startFixtureServers();
    bh2 = await launchBrowser({ webmcp: false });
    mcp2 = await startClient(PORT - 1);
    await waitConnected(mcp2.client);
    await ok(mcp2.client, 'tab_open', { url: `${srv2.a}/webmcp.html` });
  });
  after(async () => {
    await mcp2?.close();
    await bh2?.close();
    await srv2?.close();
  });

  it('explains how to enable WebMCP instead of returning an empty list', async () => {
    const r = await call(mcp2.client, 'webmcp_list');
    assert.ok(r.isError);
    assert.match(r.text, /WebMCP is not available on this page[\s\S]*chrome:\/\/flags\/#enable-webmcp-testing/);
  });
});

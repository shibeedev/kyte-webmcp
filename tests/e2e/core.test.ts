/** Full flow: MCP client → bridge (stdio) → WebSocket → extension → Chrome, for tabs, navigation, page understanding, input, screenshots, JS and console. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { call, launchBrowser, ok, refOf, startClient, waitConnected, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';

const PORT = 17839;
let srv: FixtureServers;
let bh: BrowserHandle;
let mcp: McpHandle;

describe('core flow', () => {
  before(async () => {
    srv = await startFixtureServers();
    bh = await launchBrowser();
    mcp = await startClient(PORT);
    await waitConnected(mcp.client);
  });
  after(async () => {
    await mcp?.close();
    await bh?.close();
    await srv?.close();
  });

  it('lists all tools and reports status', async () => {
    const { tools } = await mcp.client.listTools();
    assert.ok(tools.length >= 50, `expected ≥50 tools, got ${tools.length}`);
    const status = await ok(mcp.client, 'browser_status');
    assert.match(status.text, /Extension: connected/);
    assert.match(status.text, /MCP client: kyte-e2e/);
  });

  it('opens a tab in the session group and navigates', async () => {
    const opened = await ok(mcp.client, 'tab_open', { url: `${srv.a}/index.html` });
    assert.match(opened.text, /Opened tab \d+: Kyte Test Shop/);
    const indexTab = Number(opened.text.match(/Opened tab (\d+)/)![1]);
    // The debugger was attached before the page loaded: its own load is on record, with no blank page in the history.
    assert.match((await ok(mcp.client, 'network_requests', { types: ['Document'] })).text, /GET 200 Document text\/html .*index\.html/);
    assert.match((await ok(mcp.client, 'page_info')).text, /Main document: HTTP 200/);
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'history.length' })).text, /\b1\b/);
    const failed = await call(mcp.client, 'tab_open', { url: 'http://kyte-webmcp-does-not-exist.invalid/' });
    assert.ok(failed.isError, failed.text);
    assert.match(failed.text, /Opened tab \d+, but loading .* failed: net::ERR_NAME_NOT_RESOLVED/);
    await ok(mcp.client, 'tab_close', { tabIds: [Number(failed.text.match(/Opened tab (\d+)/)![1])] });
    await ok(mcp.client, 'tab_select', { tabId: indexTab });
    const list = await ok(mcp.client, 'tabs_list');
    assert.match(list.text, /Kyte Test Shop.*TARGET.*group "kyte-e2e" \(agent\)/);
    const nav = await ok(mcp.client, 'navigate', { url: `${srv.a}/page2.html` });
    assert.match(nav.text, /page2\.html · title: Second page · HTTP 200/);
    const back = await ok(mcp.client, 'navigate', { action: 'back' });
    assert.match(back.text, /index\.html/);
    const bad = await call(mcp.client, 'navigate', { url: 'http://kyte-webmcp-does-not-exist.invalid/' });
    assert.ok(bad.isError);
    assert.match(bad.text, /ERR_NAME_NOT_RESOLVED|failed/);
    // The error page left behind fires its load event late: this navigate must still wait for index.html itself
    // (the next test reads the iframes right away).
    await ok(mcp.client, 'navigate', { url: `${srv.a}/index.html` });
  });

  it('snapshots the accessibility tree across shadow DOM and cross-origin iframes', async () => {
    const snap = await ok(mcp.client, 'page_snapshot');
    assert.match(snap.text, /heading "Kyte Test Shop"/);
    assert.match(snap.text, /textbox "Email" \[ref=e\d+\] \[required\]/);
    assert.match(snap.text, /button "Shadow button" \[ref=e\d+\]/);
    assert.match(snap.text, /button "Closed shadow button" \[ref=e\d+\]/);
    assert.match(snap.text, /Cross-origin frame text/);
    assert.match(snap.text, /button "Cross frame button" \[ref=e\d+\]/);
    assert.match(snap.text, /Same-origin frame text/);
    const again = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    assert.equal(refOf(again.text, /textbox "Email"/), refOf(snap.text, /textbox "Email"/), 'refs stay stable');
    const vp = await ok(mcp.client, 'page_snapshot', { viewportOnly: true });
    assert.doesNotMatch(vp.text, /Bottom of the page/);
  });

  it('handles dialogs opened by a click', async () => {
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    const clicked = await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Confirm"/) });
    assert.match(clicked.text, /confirm dialog is open: "Sure\?"/);
    const blockedAt = Date.now();
    const blocked = await call(mcp.client, 'click', { ref: refOf(snap.text, /button "Show alert"/) });
    assert.ok(blocked.isError);
    assert.match(blocked.text, /confirm dialog is open \("Sure\?"\)\. Use the dialog tool first/);
    assert.ok(Date.now() - blockedAt < 3000, 'reported at once instead of hanging');
    await ok(mcp.client, 'dialog', { action: 'accept' });
    const state = await ok(mcp.client, 'evaluate', { expression: 'document.getElementById("result").textContent' });
    assert.match(state.text, /confirmed/);
    const prompted = await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Prompt"/) });
    assert.match(prompted.text, /prompt dialog/);
    await ok(mcp.client, 'dialog', { action: 'accept', promptText: 'Quan' });
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'result.textContent' })).text, /prompt:Quan/);
  });

  it('types, fills forms and selects options', async () => {
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    await ok(mcp.client, 'type', { ref: refOf(snap.text, /textbox "Email"/), text: 'first@example.com' });
    await ok(mcp.client, 'type', { ref: refOf(snap.text, /textbox "Email"/), text: 'me@example.com', clear: true });
    const filled = await ok(mcp.client, 'fill_form', {
      fields: [
        { ref: refOf(snap.text, /textbox "Password"/), value: 'hunter2' },
        { ref: refOf(snap.text, /checkbox "I agree"/), value: 'true' },
        { ref: refOf(snap.text, /radio "Pro"/), value: 'true' },
        { ref: refOf(snap.text, /combobox "Country"/), value: 'Japan' },
        { ref: refOf(snap.text, /textbox "Bio"/), value: 'Hello\nworld' },
      ],
    });
    assert.match(filled.text, /Filled 5 fields/);
    const values = await ok(mcp.client, 'evaluate', { function: '() => [email.value, pw.value, agree.checked, planPro.checked, country.value, bio.value]' });
    assert.match(values.text.replace(/\s+/g, ''), /"me@example.com","hunter2",true,true,"jp","Hello\\nworld"/);
    await ok(mcp.client, 'select_option', { ref: refOf(snap.text, /combobox "Country"/), values: ['us'] });
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'country.value' })).text, /"us"/);
    const submitted = await ok(mcp.client, 'type', { ref: refOf(snap.text, /textbox "Email"/), text: 'x', submit: true });
    assert.ok(!submitted.isError);
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'result.textContent' })).text, /submitted:me@example.comx/);
  });

  it('hovers, double-clicks, presses keys and scrolls', async () => {
    const found = await ok(mcp.client, 'find', { text: 'Hover me' });
    const hoverRef = found.text.match(/\[ref=(e\d+)\]/)![1]!;
    await ok(mcp.client, 'hover', { ref: hoverRef });
    await ok(mcp.client, 'wait_for', { text: 'Tooltip visible', timeoutMs: 3000 });
    const dbl = await ok(mcp.client, 'find', { role: 'button', name: 'Double click me' });
    await ok(mcp.client, 'click', { ref: dbl.text.match(/\[ref=(e\d+)\]/)![1]!, clickCount: 2 });
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'result.textContent' })).text, /double clicked/);
    const scrolled = await ok(mcp.client, 'scroll', { toEdge: 'bottom' });
    assert.doesNotMatch(scrolled.text, /position is now 0,0 /);
    const vp = await ok(mcp.client, 'page_snapshot', { viewportOnly: true });
    assert.match(vp.text, /Bottom of the page/);
    await ok(mcp.client, 'scroll', { toEdge: 'top' });
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    await ok(mcp.client, 'click', { ref: refOf(snap.text, /textbox "Bio"/) });
    await ok(mcp.client, 'press_key', { keys: 'Control+A' });
    await ok(mcp.client, 'press_key', { keys: 'Backspace' });
    await ok(mcp.client, 'type', { text: 'AB', slowly: true });
    await ok(mcp.client, 'press_key', { keys: 'ArrowLeft' });
    await ok(mcp.client, 'type', { text: 'x' });
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'bio.value' })).text, /"AxB"/);
  });

  it('drags with HTML5 drag and drop', async () => {
    const src = await ok(mcp.client, 'find', { selector: '#drag-src' });
    const dst = await ok(mcp.client, 'find', { selector: '#drop-zone' });
    const r = await ok(mcp.client, 'drag', { fromRef: src.text.match(/\[ref=(e\d+)\]/)![1]!, toRef: dst.text.match(/\[ref=(e\d+)\]/)![1]! });
    assert.match(r.text, /HTML5/);
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'result.textContent' })).text, /dropped:payload-42/);
  });

  it('interacts inside shadow DOM and cross-origin iframes', async () => {
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Shadow button"/) });
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'result.textContent' })).text, /shadow clicked/);
    await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Closed shadow button"/) });
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'result.textContent' })).text, /closed shadow clicked/);
    await ok(mcp.client, 'type', { ref: refOf(snap.text, /textbox "Cross input"/), text: 'hi' });
    await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Cross frame button"/) });
    const full = await ok(mcp.client, 'page_snapshot');
    const frameRef = refOf(full.text, /Iframe "Cross origin frame"|Iframe.*Cross/);
    const inFrame = await ok(mcp.client, 'evaluate', { expression: 'document.getElementById("crossBtn").textContent', frame: frameRef });
    assert.match(inFrame.text, /Cross frame clicked: hi/);
  });

  it('uploads files', async () => {
    const f = await ok(mcp.client, 'find', { selector: '#file' });
    const ref = f.text.match(/\[ref=(e\d+)\]/)![1]!;
    const r = await ok(mcp.client, 'upload_file', { ref, paths: [new URL('../fixtures/site/media/sample.vtt', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')] });
    assert.match(r.text, /Attached 1 file: sample\.vtt/);
  });

  it('takes screenshots, annotated and saved', async () => {
    const shot = await ok(mcp.client, 'screenshot');
    assert.equal(shot.images.length, 1);
    assert.equal(shot.images[0]!.mimeType, 'image/jpeg');
    const domBefore = await ok(mcp.client, 'evaluate', { expression: 'document.body.outerHTML' });
    const annotated = await ok(mcp.client, 'screenshot', { annotate: true, format: 'png' });
    assert.match(annotated.text, /interactive elements labelled/);
    assert.equal(annotated.images[0]!.mimeType, 'image/png');
    assert.equal((await ok(mcp.client, 'evaluate', { expression: 'document.body.outerHTML' })).text, domBefore.text, 'labels are drawn on the image only');
    const el = await ok(mcp.client, 'find', { text: 'Kyte Test Shop' });
    const elShot = await ok(mcp.client, 'screenshot', { ref: el.text.match(/\[ref=(e\d+)\]/)![1]! });
    assert.match(elShot.text, /Screenshot of the heading/);
    const saved = await ok(mcp.client, 'screenshot', { fullPage: true });
    assert.match(saved.text, /full page/);
  });

  it('evaluates JavaScript safely', async () => {
    const r = await ok(mcp.client, 'evaluate', { expression: 'window.appState' });
    assert.match(r.text, /"user": "tester"/);
    assert.match(r.text, /<body>/);
    const fn = await ok(mcp.client, 'evaluate', { function: '(a, b) => a + b', args: [2, 40] });
    assert.match(fn.text, /42/);
    const isolated = await ok(mcp.client, 'evaluate', { expression: 'typeof window.appState', world: 'isolated' });
    assert.match(isolated.text, /"undefined"/);
    const err = await call(mcp.client, 'evaluate', { expression: 'nope.nope' });
    assert.ok(err.isError);
    assert.match(err.text, /ReferenceError/);
    const promise = await ok(mcp.client, 'evaluate', { expression: 'new Promise(r => setTimeout(() => r(7), 50))' });
    assert.match(promise.text, /7/);
  });

  it('reads console logs including messages from before the agent attached', async () => {
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    const thrown = await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Throw"/) });
    assert.match(thrown.text, /Clicked/);
    assert.match(thrown.text, /1 new console error: .*Boom from test/, 'the action summary mentions new console errors');
    await new Promise((r) => setTimeout(r, 300));
    const logs = await ok(mcp.client, 'console_logs');
    assert.match(logs.text, /page loaded \{a: 1, list: \[1, 2, 3\]\}|page loaded/);
    assert.match(logs.text, /WARNING +a warning/);
    assert.match(logs.text, /ERROR +an error message/);
    assert.match(logs.text, /Boom from test/);
    assert.match(logs.text, /hello from cross frame/);
    const errors = await ok(mcp.client, 'console_logs', { levels: ['error'] });
    assert.doesNotMatch(errors.text, /a warning/);
  });

  it('reads the page as Markdown', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/page2.html` });
    const md = await ok(mcp.client, 'page_read');
    assert.match(md.text, /# Second page/);
    assert.match(md.text, /\[docs link\]\(https:\/\/example\.com\/docs\)/);
    assert.match(md.text, /\| Name \| Price \|/);
    assert.match(md.text, /- Alpha/);
    assert.match(md.text, /```\nconst x = 1;\n```/);
  });

  it('records new tabs opened by actions and adds them to the group', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/index.html` });
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    const r = await ok(mcp.client, 'click', { ref: refOf(snap.text, /button "Open popup"/) });
    assert.match(r.text, /Opened new tab \d+/);
    const list = await ok(mcp.client, 'tabs_list');
    assert.equal((list.text.match(/group "kyte-e2e"/g) ?? []).length >= 2, true, list.text);
  });

  it('acts on a background tab without slowing down', async () => {
    // The popup from the previous test now covers the target tab, as when the user browses elsewhere.
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'document.visibilityState' })).text, /hidden/);
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    const timed = async (name: string, args: Record<string, unknown>) => {
      const started = Date.now();
      const r = await ok(mcp.client, name, args);
      return { text: r.text, ms: Date.now() - started };
    };
    const steps = {
      click: await timed('click', { ref: refOf(snap.text, /checkbox "I agree"/) }),
      type: await timed('type', { ref: refOf(snap.text, /textbox "Email"/), text: 'bg@example.com', clear: true }),
      fill: await timed('fill_form', { fields: [{ ref: refOf(snap.text, /textbox "Password"/), value: 'pw' }] }),
      scroll: await timed('scroll', { direction: 'down', amount: 300 }),
    };
    for (const [name, step] of Object.entries(steps)) assert.ok(step.ms < 3000, `${name} took ${step.ms} ms`);
    assert.match(steps.scroll.text, /scrolled with script/);
    const state = await ok(mcp.client, 'evaluate', { expression: '[agree.checked, email.value, pw.value, scrollY > 0]' });
    assert.match(state.text.replace(/\s+/g, ''), /\[true,"bg@example.com","pw",true\]/);
  });

  it('reports stale refs instead of acting on another element', async () => {
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    const dblRef = refOf(snap.text, /button "Double click me"/);
    await ok(mcp.client, 'evaluate', { expression: 'dblBtn.remove(); result.textContent = "untouched"' });
    const gone = await call(mcp.client, 'click', { ref: dblRef });
    assert.ok(gone.isError, gone.text);
    assert.match(gone.text, /no longer exists/);
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'result.textContent' })).text, /untouched/);
    const emailRef = refOf(snap.text, /textbox "Email"/);
    await ok(mcp.client, 'navigate', { action: 'reload' });
    const stale = await call(mcp.client, 'type', { ref: emailRef, text: 'x' });
    assert.ok(stale.isError, stale.text);
    assert.match(stale.text, /Unknown ref .*Refs reset when the page navigates/);
  });

  it('ends waits at their deadline', async () => {
    const started = Date.now();
    const r = await call(mcp.client, 'wait_for', { text: 'This text never appears', timeoutMs: 1500 });
    assert.ok(r.isError, r.text);
    assert.match(r.text, /Timed out after 1500 ms waiting for/);
    assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
  });

  it('splits long results and says how to get the rest', async () => {
    const first = await ok(mcp.client, 'page_read', { maxChars: 200 });
    const next = first.text.match(/call page_read with offset=(\d+)/);
    assert.ok(next, first.text);
    const second = await ok(mcp.client, 'page_read', { maxChars: 200, offset: Number(next[1]) });
    assert.match(second.text, new RegExp(`\\(from character ${next[1]}\\)`));
    const snap = await ok(mcp.client, 'page_snapshot', { maxChars: 300 });
    assert.match(snap.text, /… \[truncated \d+ more characters; narrow it with interactiveOnly=true/);
  });

  it('delivers input as trusted user events', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/index.html` });
    await ok(mcp.client, 'evaluate', { expression: 'window.seen = []; for (const t of ["click", "keydown", "input"]) document.addEventListener(t, (e) => seen.push(`${e.type}:${e.isTrusted}`), true); 1' });
    const snap = await ok(mcp.client, 'page_snapshot', { interactiveOnly: true });
    await ok(mcp.client, 'click', { ref: refOf(snap.text, /textbox "Email"/) });
    assert.match((await ok(mcp.client, 'type', { text: 'a' })).text, /Typed 1 characters key by key/);
    await ok(mcp.client, 'type', { text: 'b', slowly: true });
    const seen = (await ok(mcp.client, 'evaluate', { expression: 'seen.join(" ")' })).text;
    assert.match(seen, /click:true/);
    assert.match(seen, /keydown:true/);
    assert.match(seen, /input:true/);
    assert.doesNotMatch(seen, /:false/);
    // Vietnamese diacritics go through the IME path; a line break is text, not the Enter key.
    const bio = refOf(snap.text, /textbox "Bio"/);
    await ok(mcp.client, 'type', { ref: bio, text: 'Xin chào, Quân!\nDòng hai', clear: true });
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'bio.value' })).text, /"Xin chào, Quân!\\nDòng hai"/);
    const long = await ok(mcp.client, 'type', { ref: bio, text: 'x'.repeat(250), clear: true });
    assert.match(long.text, /Typed 250 characters in one go like a paste/);
    assert.match((await ok(mcp.client, 'evaluate', { expression: 'bio.value.length' })).text, /\b250\b/);
  });
});

describe('bridge without a browser', () => {
  it('lists every tool and explains the missing connection before any extension connects', async () => {
    const lonely = await startClient(17831, { name: 'no-browser' });
    try {
      const { tools } = await lonely.client.listTools();
      assert.equal(tools.length, 56);
      assert.match((await ok(lonely.client, 'browser_status')).text, /Extension: NOT connected/);
    } finally {
      await lonely.close();
    }
  });
});

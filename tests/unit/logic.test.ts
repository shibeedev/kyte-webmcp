/** Unit tests for pure logic (no browser). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from '../../src/shared/validate.ts';
import { obj, str, int, arr, oneOf } from '../../src/shared/tool-spec.ts';
import { parseCaptions, parseSrt, parseTimedTextXml, parseTtml, parseVtt, parseYoutubeJson3, looksLikeCaptionUrl } from '../../src/features/video/captions.ts';
import { analyzeTrace, type TraceEvent } from '../../src/features/performance/trace-analyzer.ts';
import { summarizeHeapSnapshot, usedBytes } from '../../src/features/full-devtools/services.ts';
import { gridColumns, mediaPanelSummary } from '../../src/features/video/handler.ts';
import { sanitizeToolName } from '../../src/bridge/mcp-server.ts';
import { globToRegExp } from '../../src/features/network/store.ts';
import { formatConsoleArgs } from '../../src/features/console/handler.ts';
import { describeIssue } from '../../src/features/issues-memory/handler.ts';
import { editingCommand, keyDef, MODIFIER_BITS } from '../../src/features/input/keys.ts';
import { rmsLevel } from '../../src/features/video/transcriber.ts';
import { summarizeArgs } from '../../src/extension/background/activity.ts';
import { allToolSpecs } from '../../src/features/specs.ts';

describe('argument validation', () => {
  const schema = obj({ ref: str('r'), count: int('c', { minimum: 1, maximum: 3 }), mode: oneOf(['a', 'b'], 'm'), list: arr(str('x'), 'l', { minItems: 1 }) }, ['ref']);
  it('accepts valid input', () => assert.equal(validateArgs(schema, { ref: 'e1', count: 2, mode: 'a', list: ['x'] }), null));
  it('reports missing, wrong-typed, out-of-range and unknown values', () => {
    assert.match(validateArgs(schema, {})!, /args\.ref is required/);
    assert.match(validateArgs(schema, { ref: 1 })!, /args\.ref must be string, got integer/);
    assert.match(validateArgs(schema, { ref: 'e', count: 9 })!, /args\.count must be <= 3/);
    assert.match(validateArgs(schema, { ref: 'e', count: 1.5 })!, /args\.count must be integer/);
    assert.match(validateArgs(schema, { ref: 'e', mode: 'z' })!, /must be one of "a", "b"/);
    assert.match(validateArgs(schema, { ref: 'e', list: [] })!, /needs at least 1 items/);
    assert.match(validateArgs(schema, { ref: 'e', extra: 1 })!, /args\.extra is not a known parameter/);
  });
  it('every tool spec is well formed', () => {
    const names = new Set<string>();
    for (const s of allToolSpecs) {
      assert.match(s.name, /^[a-z][a-z0-9_]*$/, s.name);
      assert.ok(!names.has(s.name), `duplicate ${s.name}`);
      names.add(s.name);
      assert.ok(s.description.length > 40, `${s.name} needs a real description`);
      assert.equal(s.inputSchema.type, 'object');
      for (const [k, p] of Object.entries(s.inputSchema.properties)) assert.ok(p.description, `${s.name}.${k} has no description`);
      assert.ok(!s.name.startsWith('site_'), 'site_ is reserved for page tools');
    }
    assert.equal(allToolSpecs.length, 56);
  });
});

describe('caption parsers', () => {
  it('parses WebVTT with tags and settings', () => {
    const cues = parseVtt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500 align:start\n<v Bob>Hello <b>there</b></v>\n\n00:01:02.250 --> 00:01:03.000\nSecond &amp; last');
    assert.deepEqual(cues, [{ start: 1, end: 2.5, text: 'Hello there' }, { start: 62.25, end: 63, text: 'Second & last' }]);
  });
  it('parses SRT', () => assert.deepEqual(parseSrt('1\n00:00:05,100 --> 00:00:08,000\nScene two\n'), [{ start: 5.1, end: 8, text: 'Scene two' }]));
  it('parses TTML with clock, offset and tick times', () => {
    const xml = '<tt xmlns="http://www.w3.org/ns/ttml" ttp:tickRate="10000000"><body><div><p begin="00:00:01.5" end="00:00:03">One<br/>line</p><p begin="4s" dur="1.5s">Two</p><p begin="50000000t" end="60000000t">Three</p></div></body></tt>';
    assert.deepEqual(parseTtml(xml), [{ start: 1.5, end: 3, text: 'One line' }, { start: 4, end: 5.5, text: 'Two' }, { start: 5, end: 6, text: 'Three' }]);
  });
  it('parses YouTube json3 and timedtext XML', () => {
    assert.deepEqual(parseYoutubeJson3(JSON.stringify({ events: [{ tStartMs: 1200, dDurationMs: 800, segs: [{ utf8: 'Hi ' }, { utf8: 'all' }] }, { tStartMs: 3000 }] })), [{ start: 1.2, end: 2, text: 'Hi all' }]);
    assert.deepEqual(parseTimedTextXml('<transcript><text start="1.5" dur="2">It&#39;s fine</text></transcript>'), [{ start: 1.5, end: 3.5, text: "It's fine" }]);
    assert.deepEqual(parseTimedTextXml('<timedtext><body><p t="2000" d="500">srv3</p></body></timedtext>'), [{ start: 2, end: 2.5, text: 'srv3' }]);
  });
  it('detects formats and caption URLs', () => {
    assert.equal(parseCaptions('WEBVTT\n\n00:00.000 --> 00:01.000\nx').length, 1);
    assert.equal(parseCaptions('1\n00:00:01,000 --> 00:00:02,000\nsrt\n', 'a.srt').length, 1);
    assert.ok(looksLikeCaptionUrl('https://www.youtube.com/api/timedtext?v=1', ''));
    assert.ok(looksLikeCaptionUrl('https://cdn/x', 'text/vtt'));
    assert.ok(!looksLikeCaptionUrl('https://cdn/app.js', 'text/javascript'));
  });
});

describe('trace analysis', () => {
  const pid = 7;
  const tid = 1;
  const ev = (name: string, ts: number, dur?: number, data?: Record<string, unknown>, extra: Partial<TraceEvent> = {}): TraceEvent => ({ name, ph: dur !== undefined ? 'X' : 'I', ts, dur, pid, tid, args: data ? { data } : {}, ...extra });
  const events: TraceEvent[] = [
    { name: 'thread_name', ph: 'M', ts: 0, pid, tid, args: { name: 'CrRendererMain' } },
    ev('TracingStartedInBrowser', 1, undefined, { frames: [{ frame: 'F', url: 'https://site/', processId: pid }] }, { pid: 1 }),
    ev('navigationStart', 1000, undefined, { isOutermostMainFrame: true }),
    ev('ResourceSendRequest', 1100, undefined, { requestId: 'r1', url: 'https://site/app.css', renderBlocking: 'blocking' }),
    ev('ResourceFinish', 61_100, undefined, { requestId: 'r1' }),
    ev('RunTask', 100_000, 120_000),
    ev('EvaluateScript', 100_010, 110_000, { url: 'https://site/app.js' }),
    ev('Layout', 220_100, 5_000),
    ev('firstContentfulPaint', 300_000),
    ev('RunTask', 400_000, 80_000),
    ev('FunctionCall', 400_010, 70_000, { url: 'https://site/late.js' }),
    ev('largestContentfulPaint::Candidate', 500_000, undefined, { type: 'image', size: 4000 }),
    ev('LayoutShift', 600_000, undefined, { weighted_score_delta: 0.08, had_recent_input: false }),
    ev('LayoutShift', 900_000, undefined, { weighted_score_delta: 0.05, had_recent_input: false }),
    ev('LayoutShift', 950_000, undefined, { weighted_score_delta: 0.5, had_recent_input: true }),
  ];
  const a = analyzeTrace(events);
  it('finds the main thread and page metrics', () => {
    assert.equal(a.mainThreadFound, true);
    assert.equal(a.url, 'https://site/');
    assert.equal(a.fcpMs, 299);
    assert.equal(a.lcp?.ms, 499);
    assert.equal(a.lcp?.type, 'image');
  });
  it('computes long tasks, TBT after FCP and attribution', () => {
    assert.equal(a.longTasks.count, 2);
    assert.equal(a.longTasks.top[0]!.attribution, 'https://site/app.js');
    assert.equal(a.totalBlockingTimeMs, 30);
  });
  it('computes CLS session windows ignoring input-driven shifts', () => {
    assert.equal(a.cls?.shifts, 2);
    assert.equal(a.cls?.maxWindow, 0.13);
  });
  it('reports render-blocking requests and per-script cost', () => {
    assert.deepEqual(a.renderBlocking, [{ url: 'https://site/app.css', durationMs: 60 }]);
    assert.deepEqual(a.slowestScripts.map((s) => s.url), ['https://site/app.js', 'https://site/late.js']);
    assert.ok(a.breakdownMs.scripting! > 170);
    assert.ok(a.breakdownMs.rendering! >= 5);
  });
});

describe('full DevTools summaries', () => {
  it('turns nested block coverage into used bytes', () => {
    // Function 0..100 ran, but 20..40 inside it never did; a second function 120..150 never ran.
    const fns = [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 20, endOffset: 40, count: 0 }] }, { ranges: [{ startOffset: 120, endOffset: 150, count: 0 }] }];
    assert.equal(usedBytes(fns), 80);
  });
  it('summarizes a heap snapshot by class and finds detached DOM', () => {
    const snap = {
      snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'], node_types: [['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native']] } },
      nodes: [3, 0, 1, 100, 0, 0, 0, 3, 0, 3, 50, 0, 0, 0, 8, 1, 5, 40, 0, 0, 2, 2, 2, 7, 10, 0, 0, 0],
      strings: ['Foo', 'Detached HTMLDivElement', 'text'],
    };
    const s = summarizeHeapSnapshot(JSON.stringify(snap));
    assert.equal(s.nodeCount, 4);
    assert.equal(s.totalSelfSize, 200);
    assert.deepEqual(s.topClasses[0], { name: 'Foo', count: 2, selfSize: 150 });
    assert.equal(s.detachedDomNodes, 1);
    assert.deepEqual(s.detachedExamples, ['HTMLDivElement']);
  });
  it('summarizes Media panel properties', () => {
    const text = mediaPanelSummary({ kVideoTracks: JSON.stringify([{ codec: 'h264', profile: 'h264 high', 'coded size': '640x360' }]), kVideoDecoderName: 'D3D11VideoDecoder', kIsPlatformVideoDecoder: 'true', kAudioTracks: JSON.stringify([{ codec: 'aac', 'channel layout': 'MONO', 'samples per second': 44100 }]), kBitrate: '82356', kFrameUrl: 'x' });
    assert.equal(text, 'video h264 (h264 high) 640x360 · video decoder D3D11VideoDecoder (hardware) · audio aac mono 44100 Hz · Bitrate=82356');
  });
});

describe('small helpers', () => {
  it('lays out storyboards without empty cells when possible', () => {
    assert.equal(gridColumns(8), 4);
    assert.equal(gridColumns(12), 4);
    assert.equal(gridColumns(9), 3);
    assert.equal(gridColumns(6), 3);
    assert.equal(gridColumns(4), 2);
  });
  it('sanitizes page tool names with the reserved prefix', () => {
    assert.equal(sanitizeToolName('add todo!'), 'site_add_todo_');
    assert.equal(sanitizeToolName('x'.repeat(100)).length, 64);
  });
  it('matches URL globs like Chrome', () => {
    assert.ok(globToRegExp('*/api/*').test('http://a/api/x?y=1'));
    assert.ok(!globToRegExp('*/api/echo').test('http://a/api/echo2'));
    assert.ok(globToRegExp('https://?.com/*').test('https://a.com/x'));
  });
  it('formats console arguments like DevTools', () => {
    assert.equal(formatConsoleArgs([{ type: 'string', value: '%s has %d items %c!' }, { type: 'string', value: 'cart' }, { type: 'number', value: 3.7 }, { type: 'string', value: 'color: red' }]), 'cart has 3 items !');
    assert.equal(formatConsoleArgs([{ type: 'object', subtype: 'array', className: 'Array', preview: { properties: [{ name: '0', value: '1', type: 'number' }] } }, { type: 'undefined' }]), '[1] undefined');
  });
  it('describes DevTools issues', () => {
    assert.equal(describeIssue({ code: 'CookieIssue', details: { cookieIssueDetails: { cookie: { name: 'sid' }, cookieExclusionReasons: ['ExcludeSameSiteNoneInsecure'] } } }), 'CookieIssue — reason: ["ExcludeSameSiteNoneInsecure"] · cookie: sid');
  });
  it('maps keys and editing shortcuts', () => {
    assert.equal(keyDef('ctrl')!.key, 'Control');
    assert.equal(keyDef('Enter')!.text, '\r');
    assert.equal(keyDef('a')!.shiftKey, 'A');
    assert.deepEqual(editingCommand(MODIFIER_BITS.Control!, 'a'), ['selectAll']);
    assert.deepEqual(editingCommand(MODIFIER_BITS.Control! | MODIFIER_BITS.Shift!, 'z'), ['redo']);
    assert.equal(editingCommand(0, 'a'), undefined);
  });
  it('measures audio level for silence detection', () => {
    assert.equal(rmsLevel(new Int16Array(1000)), 0);
    assert.ok(rmsLevel(Int16Array.from({ length: 1000 }, (_, i) => (i % 2 ? 16000 : -16000))) > 0.4);
  });
  it('hides secrets in the activity log', () => {
    const s = summarizeArgs({ ref: 'e1', password: 'hunter2', text: 'x'.repeat(100) });
    assert.match(s, /password=•••/);
    assert.doesNotMatch(s, /hunter2/);
    assert.match(s, /text="x{57}…"/);
  });
});

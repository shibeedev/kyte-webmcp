import type { Core } from '../../extension/background/core.ts';
import type { Session } from '../../extension/background/sessions.ts';
import type { Feature } from '../../extension/background/types.ts';
import { ToolError, errorMessage, formatBytes, sleep, waitUntil } from '../../extension/background/util.ts';
import type { TraceAnalysis } from './trace-analyzer.ts';

/** Page function (isolated world): Core Web Vitals from buffered PerformanceObserver entries. */
async function webVitals() {
  const read = (type: string) =>
    new Promise<any[]>((resolve) => {
      try {
        const entries: any[] = [];
        const po = new PerformanceObserver((list) => entries.push(...list.getEntries()));
        po.observe({ type, buffered: true } as PerformanceObserverInit);
        setTimeout(() => {
          po.disconnect();
          resolve(entries);
        }, 60);
      } catch {
        resolve([]);
      }
    });
  const describe = (el: Element | null | undefined) => {
    if (!el || el.nodeType !== 1) return null;
    const cls = el.classList?.length ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}>${text ? ` "${text}"` : ''}`;
  };
  const [lcp, shifts, paints, events, navs] = await Promise.all([read('largest-contentful-paint'), read('layout-shift'), read('paint'), read('event'), read('navigation')]);
  const last = lcp[lcp.length - 1];
  let cls = 0;
  let windowValue = 0;
  let windowStart = 0;
  let previous = 0;
  const top: Array<{ value: number; at: number; sources: string[] }> = [];
  for (const s of shifts) {
    if (s.hadRecentInput) continue;
    if (!windowValue || s.startTime - previous > 1000 || s.startTime - windowStart > 5000) {
      windowValue = 0;
      windowStart = s.startTime;
    }
    windowValue += s.value;
    previous = s.startTime;
    cls = Math.max(cls, windowValue);
    top.push({ value: Math.round(s.value * 10000) / 10000, at: Math.round(s.startTime), sources: (s.sources ?? []).map((x: any) => describe(x.node)).filter(Boolean) });
  }
  const interactions = events.filter((e) => e.interactionId);
  const inp = interactions.reduce((m, e) => Math.max(m, e.duration), 0);
  const worst = interactions.sort((a, b) => b.duration - a.duration)[0];
  const nav = navs[0];
  return {
    lcp: last ? { ms: Math.round(last.startTime), element: describe(last.element), url: last.url || undefined, size: last.size } : null,
    cls: Math.round(cls * 1000) / 1000,
    shifts: top.sort((a, b) => b.value - a.value).slice(0, 5),
    inp: interactions.length ? Math.round(inp) : null,
    inpTarget: worst ? `${worst.name} on ${describe(worst.target) ?? 'unknown'}` : null,
    interactions: interactions.length,
    fcp: paints.find((p) => p.name === 'first-contentful-paint')?.startTime ?? null,
    ttfb: nav ? Math.round(nav.responseStart) : null,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd) : null,
    transferSize: nav?.transferSize ?? null,
    navigationType: nav?.type ?? null,
  };
}

function rate(value: number | null | undefined, good: number, poor: number): string {
  if (value === null || value === undefined) return 'n/a';
  return value <= good ? 'good' : value <= poor ? 'needs improvement' : 'poor';
}

const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'toplevel',
  'v8.execute',
  'disabled-by-default-v8.compile',
  'blink.console',
  'blink.user_timing',
  'loading',
  'latencyInfo',
  'disabled-by-default-lighthouse',
];

const tracing = new Map<number, { startedAt: number; path?: string }>();

async function stopTrace(core: Core, session: Session, tabId: number, savePath: string | undefined, signal: AbortSignal): Promise<string> {
  let stream: string | undefined;
  const off = core.cdp.on((t, s, method, params) => {
    if (t === tabId && !s && method === 'Tracing.tracingComplete') stream = params.stream ?? 'none';
  });
  try {
    await core.cdp.send(tabId, 'Tracing.end');
    await waitUntil(() => stream, { timeoutMs: 60_000, signal, message: 'Chrome did not finish writing the trace.' });
  } finally {
    off();
    tracing.delete(tabId);
  }
  if (!stream || stream === 'none') throw new ToolError('Chrome returned no trace data.');
  const handle = stream;
  const saved = await session.streamFile({ path: savePath, stem: 'trace', ext: 'json' }, async (write) => {
    for (;;) {
      const chunk = await core.cdp.send(tabId, 'IO.read', { handle, size: 1_048_576 });
      if (chunk.data) await write(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      if (chunk.eof) break;
    }
  });
  await core.cdp.send(tabId, 'IO.close', { handle }).catch(() => {});
  let analysis: TraceAnalysis;
  try {
    analysis = await session.service<TraceAnalysis>('trace.analyze', { path: saved.path });
  } catch (error) {
    return `Trace saved to ${saved.path} (${formatBytes(saved.bytes)}), but the analysis failed: ${errorMessage(error)}. Open it in DevTools > Performance.`;
  }
  const a = analysis;
  const lines = [
    `Trace saved to ${saved.path} (${formatBytes(saved.bytes)}) — open it in DevTools > Performance > Load profile.`,
    `Recorded ${a.durationMs} ms of ${a.url ?? 'the page'}${a.mainThreadFound ? '' : ' (main thread not identified; numbers may be incomplete)'}.`,
    `FCP ${a.fcpMs ?? 'n/a'} ms (${rate(a.fcpMs, 1800, 3000)}) · LCP ${a.lcp ? `${a.lcp.ms} ms (${rate(a.lcp.ms, 2500, 4000)}${a.lcp.type ? `, ${a.lcp.type}` : ''})` : 'n/a'} · CLS ${a.cls?.maxWindow ?? 0} (${rate(a.cls?.maxWindow, 0.1, 0.25)}, ${a.cls?.shifts ?? 0} shifts) · TBT ${a.totalBlockingTimeMs} ms (${rate(a.totalBlockingTimeMs, 200, 600)})`,
    `DOMContentLoaded ${a.domContentLoadedMs ?? 'n/a'} ms · load ${a.loadMs ?? 'n/a'} ms · ${a.requests} requests`,
    `Main thread (self time): ${Object.entries(a.breakdownMs).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v} ms`).join(', ') || 'n/a'}`,
    `Long tasks: ${a.longTasks.count} (${a.longTasks.totalMs} ms)${a.longTasks.top.length ? `\n${a.longTasks.top.map((t) => `  - ${t.durationMs} ms at ${t.startMs} ms${t.attribution ? ` (${t.attribution})` : ''}`).join('\n')}` : ''}`,
    a.renderBlocking.length ? `Render-blocking requests:\n${a.renderBlocking.map((r) => `  - ${r.durationMs} ms ${r.url}`).join('\n')}` : 'Render-blocking requests: none detected',
    a.slowestScripts.length ? `Most expensive scripts:\n${a.slowestScripts.map((s) => `  - ${s.ms} ms ${s.url}`).join('\n')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

interface SheetInfo {
  url: string;
  length: number;
  inline: boolean;
}
const sheets = new Map<number, Map<string, SheetInfo>>();
const coverageState = new Map<number, { css: boolean; js: boolean; jsError?: string }>();

export const performanceFeature: Feature = {
  name: 'performance',
  setup(core) {
    core.cdp.on((tabId, sessionId, method, params) => {
      if (method === 'CSS.styleSheetAdded' && !sessionId) {
        let map = sheets.get(tabId);
        if (!map) sheets.set(tabId, (map = new Map()));
        const h = params.header;
        map.set(h.styleSheetId, { url: h.sourceURL || `(inline <style> in ${h.ownerNode ?? 'document'})`, length: h.length, inline: !!h.isInline || !h.sourceURL });
      }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      sheets.delete(tabId);
      coverageState.delete(tabId);
      tracing.delete(tabId);
    });
  },
  handlers: {
    async perf_metrics(_args, { core, tabId }) {
      await core.cdp.ensure(tabId);
      await core.cdp.send(tabId, 'Performance.enable', { timeDomain: 'timeTicks' }).catch(() => {});
      const { metrics } = await core.cdp.send(tabId, 'Performance.getMetrics');
      const m = new Map<string, number>((metrics as Array<{ name: string; value: number }>).map((x) => [x.name, x.value]));
      const v = await core.page.evaluate<Awaited<ReturnType<typeof webVitals>>>(tabId, webVitals);
      const lines = [
        'Core Web Vitals (this page load, field-style measurement):',
        `- LCP ${v.lcp ? `${v.lcp.ms} ms (${rate(v.lcp.ms, 2500, 4000)}) — ${v.lcp.element ?? 'element gone'}${v.lcp.url ? ` ${v.lcp.url}` : ''}` : 'not reported yet'}`,
        `- CLS ${v.cls} (${rate(v.cls, 0.1, 0.25)})${v.shifts.length ? `\n${v.shifts.map((s) => `    shift ${s.value} at ${s.at} ms: ${s.sources.join(', ') || 'unknown elements'}`).join('\n')}` : ''}`,
        `- INP ${v.inp !== null ? `${v.inp} ms (${rate(v.inp, 200, 500)}) — ${v.inpTarget}` : `n/a (${v.interactions} slow interactions recorded; interact with the page first)`}`,
        `- FCP ${v.fcp !== null ? `${Math.round(v.fcp)} ms (${rate(v.fcp, 1800, 3000)})` : 'n/a'} · TTFB ${v.ttfb ?? 'n/a'} ms (${rate(v.ttfb, 800, 1800)}) · DOMContentLoaded ${v.domContentLoaded ?? 'n/a'} ms · load ${v.load ?? 'n/a'} ms${v.transferSize ? ` · document ${formatBytes(v.transferSize)}` : ''}${v.navigationType ? ` · ${v.navigationType}` : ''}`,
        'Runtime:',
        `- JS heap ${formatBytes(m.get('JSHeapUsedSize') ?? 0)} used of ${formatBytes(m.get('JSHeapTotalSize') ?? 0)} · DOM nodes ${m.get('Nodes')} · documents ${m.get('Documents')} · frames ${m.get('Frames')} · event listeners ${m.get('JSEventListeners')}`,
        `- Layouts ${m.get('LayoutCount')} (${Math.round((m.get('LayoutDuration') ?? 0) * 1000)} ms) · style recalcs ${m.get('RecalcStyleCount')} (${Math.round((m.get('RecalcStyleDuration') ?? 0) * 1000)} ms) · script ${Math.round((m.get('ScriptDuration') ?? 0) * 1000)} ms · tasks ${Math.round((m.get('TaskDuration') ?? 0) * 1000)} ms`,
      ];
      return lines.join('\n');
    },

    async perf_trace(args: { action?: 'run' | 'start' | 'stop'; reload?: boolean; durationMs?: number; cpuProfile?: boolean; savePath?: string }, { core, tabId, session, signal }) {
      await core.cdp.ensure(tabId);
      const action = args.action ?? 'run';
      if (action === 'stop') {
        if (!tracing.has(tabId)) throw new ToolError('No trace is being recorded on this tab. Use action "start" first.');
        return stopTrace(core, session, tabId, args.savePath ?? tracing.get(tabId)?.path, signal);
      }
      if (tracing.has(tabId)) throw new ToolError('A trace is already being recorded on this tab; stop it first.');
      const categories = [...TRACE_CATEGORIES, ...(args.cpuProfile === false ? [] : ['disabled-by-default-v8.cpu_profiler'])];
      await core.cdp.send(tabId, 'Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json', traceConfig: { recordMode: 'recordUntilFull', includedCategories: categories } });
      const started = Date.now();
      tracing.set(tabId, { startedAt: started, path: args.savePath });
      const reload = args.reload ?? action === 'run';
      if (reload) {
        await sleep(100, signal);
        await core.cdp.send(tabId, 'Page.reload', { ignoreCache: true });
      }
      if (action === 'start') return `Recording a performance trace${reload ? ' (page reloaded)' : ''}. Interact with the page, then call perf_trace with action "stop".`;
      try {
        if (reload && !args.durationMs) {
          await core.life.waitForLoad(tabId, started, 'load', 60_000, signal);
          await sleep(3000, signal);
        } else await sleep(args.durationMs ?? 5000, signal);
      } catch (error) {
        await core.cdp.send(tabId, 'Tracing.end').catch(() => {});
        tracing.delete(tabId);
        throw error;
      }
      return stopTrace(core, session, tabId, args.savePath, signal);
    },

    async coverage(args: { action: 'start' | 'stop'; types?: Array<'css' | 'js'>; reload?: boolean; limit?: number }, { core, tabId, session }) {
      await core.cdp.ensure(tabId);
      const types = args.types?.length ? args.types : ['css', 'js'];
      if (args.action === 'start') {
        const state = { css: false, js: false, jsError: undefined as string | undefined };
        if (types.includes('css')) {
          sheets.set(tabId, new Map());
          await core.cdp.send(tabId, 'DOM.enable');
          await core.cdp.send(tabId, 'CSS.enable');
          await core.cdp.send(tabId, 'CSS.startRuleUsageTracking');
          state.css = true;
        }
        if (types.includes('js')) {
          try {
            await session.service('fdc.jsCoverage.start', { targetId: await core.targetIdFor(tabId) });
            state.js = true;
          } catch (error) {
            state.jsError = errorMessage(error);
          }
        }
        coverageState.set(tabId, state);
        if (args.reload) await core.cdp.send(tabId, 'Page.reload', { ignoreCache: true });
        return `Coverage started for ${[state.css && 'CSS', state.js && 'JavaScript'].filter(Boolean).join(' and ') || 'nothing'}${args.reload ? ' and the page is reloading' : ''}.${state.jsError ? `\nJavaScript coverage is unavailable: ${state.jsError}` : ''}\nExercise the page, then call coverage with action "stop".`;
      }
      const state = coverageState.get(tabId);
      if (!state) throw new ToolError('Coverage was not started on this tab.');
      coverageState.delete(tabId);
      const rows: Array<{ url: string; kind: string; total: number; used: number }> = [];
      if (state.css) {
        const { ruleUsage } = await core.cdp.send(tabId, 'CSS.stopRuleUsageTracking');
        const used = new Map<string, Array<[number, number]>>();
        for (const r of ruleUsage as Array<{ styleSheetId: string; startOffset: number; endOffset: number; used: boolean }>) {
          if (!r.used) continue;
          const list = used.get(r.styleSheetId) ?? [];
          list.push([r.startOffset, r.endOffset]);
          used.set(r.styleSheetId, list);
        }
        for (const [id, info] of sheets.get(tabId) ?? []) {
          const ranges = (used.get(id) ?? []).sort((a, b) => a[0] - b[0]);
          let bytes = 0;
          let end = -1;
          for (const [s, e] of ranges) {
            if (s > end) {
              bytes += e - s;
              end = e;
            } else if (e > end) {
              bytes += e - end;
              end = e;
            }
          }
          if (info.length) rows.push({ url: info.url, kind: 'css', total: info.length, used: Math.min(bytes, info.length) });
        }
        await core.cdp.send(tabId, 'CSS.disable').catch(() => {});
      }
      let jsNote = state.jsError ? `JavaScript coverage unavailable: ${state.jsError}` : '';
      if (state.js) {
        try {
          const { files } = await session.service<{ files: Array<{ url: string; total: number; used: number }> }>('fdc.jsCoverage.stop', { targetId: await core.targetIdFor(tabId) });
          for (const f of files) rows.push({ url: f.url, kind: 'js', total: f.total, used: f.used });
        } catch (error) {
          jsNote = `JavaScript coverage failed: ${errorMessage(error)}`;
        }
      }
      rows.sort((a, b) => b.total - b.used - (a.total - a.used));
      const totals = rows.reduce((acc, r) => ({ total: acc.total + r.total, used: acc.used + r.used }), { total: 0, used: 0 });
      const shown = rows.slice(0, args.limit ?? 30);
      const lines = shown.map((r) => `- ${r.kind.toUpperCase()} ${formatBytes(r.total - r.used)} unused of ${formatBytes(r.total)} (${Math.round(((r.total - r.used) / r.total) * 100)}%) ${r.url}`);
      return [
        `Coverage: ${formatBytes(totals.total - totals.used)} of ${formatBytes(totals.total)} unused (${totals.total ? Math.round(((totals.total - totals.used) / totals.total) * 100) : 0}%) across ${rows.length} files.`,
        ...lines,
        rows.length > shown.length ? `… ${rows.length - shown.length} more files` : '',
        jsNote,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
};

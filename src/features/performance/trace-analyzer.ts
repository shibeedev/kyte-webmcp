/**
 * Bridge-side analysis of a Chrome performance trace (the .json the
 * DevTools Performance panel also opens). Pure functions + one service.
 */
import { readFileSync } from 'node:fs';
import type { ServiceHandler } from '../../bridge/hub.ts';

export interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: Record<string, unknown>; [k: string]: unknown };
}

const CATEGORY: Record<string, string> = {
  EvaluateScript: 'scripting', FunctionCall: 'scripting', 'v8.compile': 'scripting', 'v8.compileModule': 'scripting', 'v8.evaluateModule': 'scripting',
  'v8.run': 'scripting', 'V8.Execute': 'scripting', TimerFire: 'scripting', EventDispatch: 'scripting', FireAnimationFrame: 'scripting',
  RunMicrotasks: 'scripting', FireIdleCallback: 'scripting', 'v8.produceCache': 'scripting', 'v8.parseOnBackground': 'scripting',
  MinorGC: 'gc', MajorGC: 'gc', 'V8.GC_SCAVENGER': 'gc', 'V8.GC_MC_BACKGROUND_MARKING': 'gc', BlinkGC: 'gc',
  Layout: 'rendering', UpdateLayoutTree: 'rendering', RecalculateStyles: 'rendering', HitTest: 'rendering', PrePaint: 'rendering', Layerize: 'rendering', IntersectionObserverController: 'rendering',
  Paint: 'painting', PaintImage: 'painting', CompositeLayers: 'painting', 'Decode Image': 'painting', 'Draw LazyPixelRef': 'painting', Commit: 'painting',
  ParseHTML: 'loading', ParseAuthorStyleSheet: 'loading', ResourceReceivedData: 'loading',
};

export interface TraceAnalysis {
  durationMs: number;
  mainThreadFound: boolean;
  url?: string;
  fcpMs?: number;
  lcp?: { ms: number; type?: string; size?: number; nodeId?: number };
  cls?: { total: number; maxWindow: number; shifts: number };
  domContentLoadedMs?: number;
  loadMs?: number;
  longTasks: { count: number; totalMs: number; top: Array<{ startMs: number; durationMs: number; attribution?: string }> };
  totalBlockingTimeMs: number;
  breakdownMs: Record<string, number>;
  renderBlocking: Array<{ url: string; durationMs: number }>;
  slowestScripts: Array<{ url: string; ms: number }>;
  requests: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function analyzeTrace(events: TraceEvent[]): TraceAnalysis {
  const threadNames = new Map<string, string>();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, String(e.args?.name ?? ''));

  // The inspected page's renderer: the last committed outermost main frame wins (reloads can swap processes).
  let mainPid: number | undefined;
  let url: string | undefined;
  for (const e of events) {
    const data = e.args?.data as Record<string, unknown> | undefined;
    if (e.name === 'TracingStartedInBrowser') {
      const frames = (data?.frames as Array<Record<string, unknown>> | undefined) ?? [];
      const main = frames.find((f) => !f.parent) ?? frames[0];
      if (main) {
        mainPid = Number(main.processId);
        url = String(main.url ?? '');
      }
    } else if (e.name === 'FrameCommittedInBrowser' && data && !data.parent && data.processId) {
      mainPid = Number(data.processId);
      url = String(data.url ?? url);
    }
  }
  const mainKeys = [...threadNames.entries()].filter(([k, n]) => n === 'CrRendererMain' && (mainPid === undefined || k.startsWith(`${mainPid}:`))).map(([k]) => k);
  const isMain = (e: TraceEvent) => mainKeys.includes(`${e.pid}:${e.tid}`);

  const timed = events.filter((e) => e.ts > 0 && e.ph !== 'M');
  // Loops, not Math.min(...spread): traces easily hold more events than the call stack allows arguments.
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = 0;
  for (const e of timed) {
    if (e.ts < t0) t0 = e.ts;
    if (e.ts + (e.dur ?? 0) > t1) t1 = e.ts + (e.dur ?? 0);
  }
  if (!timed.length) t0 = 0;

  // Navigation start of the outermost main frame anchors page metrics.
  const navStart = events.filter((e) => e.name === 'navigationStart' && (e.args?.data as Record<string, unknown> | undefined)?.isOutermostMainFrame !== false && isMainPid(e)).at(-1)?.ts ?? t0;
  function isMainPid(e: TraceEvent) {
    return mainPid === undefined || e.pid === mainPid;
  }
  const rel = (ts: number) => round((ts - navStart) / 1000);

  const fcp = events.find((e) => e.name === 'firstContentfulPaint' && isMainPid(e) && e.ts >= navStart);
  const lcpCandidates = events.filter((e) => e.name === 'largestContentfulPaint::Candidate' && isMainPid(e) && e.ts >= navStart);
  const lcpEvent = lcpCandidates.at(-1);
  const dcl = events.find((e) => e.name === 'MarkDOMContent' && isMainPid(e) && e.ts >= navStart);
  const load = events.find((e) => e.name === 'MarkLoad' && isMainPid(e) && e.ts >= navStart);

  // CLS: sum of shifts without recent input, plus the max 5 s / 1 s-gap session window.
  const shifts = events
    .filter((e) => e.name === 'LayoutShift' && isMainPid(e))
    .map((e) => ({ ts: e.ts, data: (e.args?.data ?? {}) as Record<string, unknown> }))
    .filter((s) => !s.data.had_recent_input)
    .map((s) => ({ ts: s.ts, score: Number(s.data.weighted_score_delta ?? s.data.score ?? 0) }));
  let maxWindow = 0;
  let windowScore = 0;
  let windowStart = 0;
  let prev = 0;
  for (const s of shifts) {
    if (!windowScore || s.ts - prev > 1e6 || s.ts - windowStart > 5e6) {
      windowScore = 0;
      windowStart = s.ts;
    }
    windowScore += s.score;
    prev = s.ts;
    maxWindow = Math.max(maxWindow, windowScore);
  }

  // Main-thread tasks, self time per category, long tasks.
  const mainEvents = timed.filter((e) => e.ph === 'X' && isMain(e)).sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  const breakdown: Record<string, number> = {};
  const stack: Array<{ e: TraceEvent; end: number; childDur: number }> = [];
  const flush = (until: number) => {
    while (stack.length && stack[stack.length - 1]!.end <= until) {
      const top = stack.pop()!;
      const self = Math.max(0, (top.e.dur ?? 0) - top.childDur);
      const cat = CATEGORY[top.e.name] ?? 'other';
      breakdown[cat] = (breakdown[cat] ?? 0) + self / 1000;
      if (stack.length) stack[stack.length - 1]!.childDur += top.e.dur ?? 0;
    }
  };
  const tasks: TraceEvent[] = [];
  for (const e of mainEvents) {
    flush(e.ts);
    if (e.name === 'RunTask' && !stack.length) tasks.push(e);
    stack.push({ e, end: e.ts + (e.dur ?? 0), childDur: 0 });
  }
  flush(Number.POSITIVE_INFINITY);
  for (const k of Object.keys(breakdown)) breakdown[k] = round(breakdown[k]!);

  const scriptUrl = (task: TraceEvent): string | undefined => {
    const end = task.ts + (task.dur ?? 0);
    const inner = mainEvents.find((e) => e.ts >= task.ts && e.ts < end && (e.name === 'FunctionCall' || e.name === 'EvaluateScript' || e.name === 'v8.compile') && (e.args?.data as Record<string, unknown> | undefined)?.url);
    return inner ? String((inner.args!.data as Record<string, unknown>).url) : undefined;
  };
  const long = tasks.filter((t) => (t.dur ?? 0) > 50_000);
  const fcpTs = fcp?.ts ?? navStart;
  const tbt = tasks.filter((t) => t.ts >= fcpTs).reduce((sum, t) => sum + Math.max(0, (t.dur ?? 0) / 1000 - 50), 0);

  // Script cost per URL from top-level script events.
  const perUrl = new Map<string, number>();
  let depthEnd = 0;
  for (const e of mainEvents) {
    if (!['FunctionCall', 'EvaluateScript', 'v8.compile', 'v8.compileModule', 'v8.evaluateModule'].includes(e.name)) continue;
    if (e.ts < depthEnd) continue;
    const u = (e.args?.data as Record<string, unknown> | undefined)?.url;
    if (!u) continue;
    depthEnd = e.ts + (e.dur ?? 0);
    perUrl.set(String(u), (perUrl.get(String(u)) ?? 0) + (e.dur ?? 0) / 1000);
  }

  // Network: render-blocking requests and their durations.
  const sends = new Map<string, { url: string; ts: number; blocking: boolean }>();
  for (const e of events) {
    const d = e.args?.data as Record<string, unknown> | undefined;
    if (e.name === 'ResourceSendRequest' && d?.requestId) {
      sends.set(String(d.requestId), { url: String(d.url ?? ''), ts: e.ts, blocking: d.renderBlocking === 'blocking' || d.renderBlocking === 'in_body_parser_blocking' });
    }
  }
  const renderBlocking: Array<{ url: string; durationMs: number }> = [];
  for (const e of events) {
    const d = e.args?.data as Record<string, unknown> | undefined;
    if (e.name === 'ResourceFinish' && d?.requestId) {
      const s = sends.get(String(d.requestId));
      if (s?.blocking) renderBlocking.push({ url: s.url, durationMs: round((e.ts - s.ts) / 1000) });
    }
  }

  const lcpData = (lcpEvent?.args?.data ?? {}) as Record<string, unknown>;
  return {
    durationMs: round((t1 - t0) / 1000),
    mainThreadFound: mainKeys.length > 0,
    url,
    fcpMs: fcp ? rel(fcp.ts) : undefined,
    lcp: lcpEvent ? { ms: rel(lcpEvent.ts), type: lcpData.type as string | undefined, size: lcpData.size as number | undefined, nodeId: lcpData.nodeId as number | undefined } : undefined,
    cls: { total: Math.round(shifts.reduce((s, x) => s + x.score, 0) * 1000) / 1000, maxWindow: Math.round(maxWindow * 1000) / 1000, shifts: shifts.length },
    domContentLoadedMs: dcl ? rel(dcl.ts) : undefined,
    loadMs: load ? rel(load.ts) : undefined,
    longTasks: {
      count: long.length,
      totalMs: round(long.reduce((s, t) => s + (t.dur ?? 0) / 1000, 0)),
      top: long
        .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
        .slice(0, 5)
        .map((t) => ({ startMs: rel(t.ts), durationMs: round((t.dur ?? 0) / 1000), attribution: scriptUrl(t) })),
    },
    totalBlockingTimeMs: round(tbt),
    breakdownMs: breakdown,
    renderBlocking: renderBlocking.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    slowestScripts: [...perUrl.entries()].map(([u, ms]) => ({ url: u, ms: round(ms) })).sort((a, b) => b.ms - a.ms).slice(0, 8),
    requests: sends.size,
  };
}

export function traceServices(): Record<string, ServiceHandler> {
  return {
    'trace.analyze': async (a) => {
      const parsed = JSON.parse(readFileSync(String(a.path), 'utf8')) as { traceEvents?: TraceEvent[] } | TraceEvent[];
      const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
      return analyzeTrace(events);
    },
  };
}

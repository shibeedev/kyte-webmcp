import { arr, bool, defineTools, int, obj, oneOf, savePathParam, tabIdParam } from '../../shared/tool-spec.ts';

export const performanceTools = defineTools(
  {
    name: 'perf_metrics',
    title: 'Web Vitals & runtime metrics',
    description:
      'Measures Core Web Vitals of the current page (LCP with its element, CLS with the shifting elements, INP, FCP, TTFB) and runtime metrics (JS heap, DOM nodes, layouts, style recalcs, script time).',
    inputSchema: obj({ tabId: tabIdParam }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'perf_trace',
    title: 'Performance trace',
    description:
      'Records a performance trace like the DevTools Performance panel (optionally reloading the page first), saves the .json trace (open it in DevTools > Performance) and returns an analysis: long tasks, total blocking time, main-thread breakdown, render-blocking requests, LCP, CLS and the slowest scripts. Use action "start"/"stop" for manual recording or "run" to record for durationMs.',
    inputSchema: obj({
      action: oneOf(['run', 'start', 'stop'], 'Recording mode (default run).'),
      reload: bool('Reload the page when recording starts (default true for run).'),
      durationMs: int('How long to record for action run (default 5000, or until load + 3 s when reloading).', { minimum: 500, maximum: 120000 }),
      cpuProfile: bool('Include JavaScript CPU samples for the flame chart (default true).'),
      savePath: savePathParam,
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 180_000,
  },
  {
    name: 'coverage',
    title: 'Code coverage',
    description:
      'Measures unused CSS and JavaScript per file like the DevTools Coverage panel. Call with action "start", exercise the page, then "stop". CSS coverage always works; JavaScript coverage needs the full DevTools channel.',
    inputSchema: obj(
      {
        action: oneOf(['start', 'stop'], 'Start or stop measuring.'),
        types: arr(oneOf(['css', 'js'], 'Kind'), 'What to measure (default both).'),
        reload: bool('Reload the page right after starting, to cover page load (default false).'),
        limit: int('Show at most this many files (default 30).'),
        tabId: tabIdParam,
      },
      ['action'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 60_000,
  },
);

import { bool, defineTools, int, obj, oneOf, savePathParam, tabIdParam } from '../../shared/tool-spec.ts';

export const issuesMemoryTools = defineTools(
  {
    name: 'devtools_issues',
    title: 'DevTools issues',
    description: 'Lists the problems the DevTools Issues panel detected on the page: CORS, mixed content, cookie and SameSite problems, Content Security Policy violations, deprecated APIs, quirks mode, heavy ads and more.',
    inputSchema: obj({ limit: int('Maximum issues (default 50).'), clear: bool('Clear after reading.'), tabId: tabIdParam }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'memory',
    title: 'Memory',
    description:
      'action "counters": JS heap size, DOM nodes, documents, frames and event listeners. action "snapshot": takes a heap snapshot like the DevTools Memory panel (saved as .heapsnapshot, loadable in DevTools) and summarizes the biggest object classes and detached DOM nodes; needs the full DevTools channel.',
    inputSchema: obj({ action: oneOf(['counters', 'snapshot'], 'What to do (default counters).'), gc: bool('Collect garbage first (default true for snapshot).'), savePath: savePathParam, tabId: tabIdParam }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 180_000,
  },
);

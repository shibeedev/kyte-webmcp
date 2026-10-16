import type { Feature } from '../../extension/background/types.ts';
import { errorMessage, formatBytes } from '../../extension/background/util.ts';

interface Issue {
  at: number;
  code: string;
  text: string;
}

const MAX_ISSUES = 200;
const issues = new Map<number, Issue[]>();

/** Turns an Audits.InspectorIssue into one readable line. */
export function describeIssue(issue: { code: string; details: Record<string, any> }): string {
  const d = Object.values(issue.details ?? {})[0] ?? {};
  const parts: string[] = [];
  const pick = (label: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') parts.push(`${label}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  };
  pick('reason', d.cookieExclusionReasons ?? d.cookieWarningReasons ?? d.violationType ?? d.errorType ?? d.type ?? d.resolutionStatus ?? d.corsErrorStatus?.corsError);
  pick('cookie', d.cookie?.name ?? d.rawCookieLine);
  pick('url', d.request?.url ?? d.insecureURL ?? d.blockedURL ?? d.url ?? d.sourceCodeLocation?.url);
  pick('directive', d.violatedDirective);
  pick('element', d.violatingNodeSelector);
  if (d.contrastRatio) pick('contrast', `${Math.round(d.contrastRatio * 100) / 100} (needs ${d.thresholdAA})`);
  if (d.sourceCodeLocation?.lineNumber !== undefined) pick('line', d.sourceCodeLocation.lineNumber + 1);
  return `${issue.code}${parts.length ? ` — ${parts.join(' · ')}` : ''}`;
}

export const issuesMemoryFeature: Feature = {
  name: 'issues-memory',
  setup(core) {
    core.cdp.onAttach(async (tabId, sessionId, type) => {
      if (!sessionId || type === 'iframe') await core.cdp.send(tabId, 'Audits.enable', {}, sessionId).catch(() => {});
    });
    core.cdp.on((tabId, _sessionId, method, params) => {
      if (method !== 'Audits.issueAdded') return;
      let list = issues.get(tabId);
      if (!list) issues.set(tabId, (list = []));
      const text = describeIssue(params.issue);
      if (list.some((i) => i.text === text)) return; // DevTools also groups duplicates
      list.push({ at: Date.now(), code: params.issue.code, text });
      if (list.length > MAX_ISSUES) list.shift();
    });
    chrome.tabs.onRemoved.addListener((tabId) => issues.delete(tabId));
  },
  handlers: {
    async devtools_issues(args: { limit?: number; clear?: boolean }, { core, tabId }) {
      await core.cdp.ensure(tabId);
      const list = issues.get(tabId) ?? [];
      const shown = list.slice(-(args.limit ?? 50));
      if (args.clear) issues.delete(tabId);
      if (!shown.length) return 'DevTools reports no issues for this page.';
      return `${list.length} issue${list.length === 1 ? '' : 's'}:\n${shown.map((i) => `- ${i.text}`).join('\n')}`;
    },

    async memory(args: { action?: 'counters' | 'snapshot'; gc?: boolean; savePath?: string }, { core, tabId, session }) {
      await core.cdp.ensure(tabId);
      if ((args.action ?? 'counters') === 'counters') {
        await core.cdp.send(tabId, 'Performance.enable', { timeDomain: 'timeTicks' }).catch(() => {});
        const { metrics } = await core.cdp.send(tabId, 'Performance.getMetrics');
        const m = new Map<string, number>((metrics as Array<{ name: string; value: number }>).map((x) => [x.name, x.value]));
        const heap = await core.cdp.send(tabId, 'Runtime.getHeapUsage').catch(() => null);
        return [
          `JS heap: ${formatBytes(heap?.usedSize ?? m.get('JSHeapUsedSize') ?? 0)} used of ${formatBytes(heap?.totalSize ?? m.get('JSHeapTotalSize') ?? 0)}${heap?.embedderHeapUsedSize ? ` · embedder ${formatBytes(heap.embedderHeapUsedSize)}` : ''}`,
          `DOM nodes: ${m.get('Nodes')} · documents: ${m.get('Documents')} · frames: ${m.get('Frames')} · event listeners: ${m.get('JSEventListeners')} · layout objects: ${m.get('LayoutObjects') ?? 'n/a'}`,
        ].join('\n');
      }
      let res: { path: string; bytes: number; summary: { nodeCount: number; totalSelfSize: number; topClasses: Array<{ name: string; count: number; selfSize: number }>; detachedDomNodes: number; detachedExamples: string[] } };
      try {
        res = await session.service('fdc.heapSnapshot', { targetId: await core.targetIdFor(tabId), path: args.savePath, gc: args.gc !== false });
      } catch (error) {
        return { content: [{ type: 'text', text: `Heap snapshots need the full DevTools channel, which is not available: ${errorMessage(error)}` }], isError: true };
      }
      const s = res.summary;
      return [
        `Heap snapshot saved to ${res.path} (${formatBytes(res.bytes)}) — load it in DevTools > Memory.`,
        `${s.nodeCount.toLocaleString()} objects, ${formatBytes(s.totalSelfSize)} total self size.`,
        `Detached DOM nodes: ${s.detachedDomNodes}${s.detachedExamples.length ? ` (e.g. ${s.detachedExamples.join(', ')})` : ''}`,
        'Largest classes by self size:',
        ...s.topClasses.slice(0, 15).map((c) => `  - ${c.name || '(anonymous)'}: ${c.count.toLocaleString()} × = ${formatBytes(c.selfSize)}`),
      ].join('\n');
    },
  },
};

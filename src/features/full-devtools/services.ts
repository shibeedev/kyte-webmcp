import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import type { ServiceHandler } from '../../bridge/hub.ts';
import { resolveTarget } from '../../bridge/files.ts';
import type { BridgeContext } from '../../bridge/types.ts';
import type { FullCdpClient } from './client.ts';

function waitForEvents(client: FullCdpClient, sessionId: string, ms: number, filter: (method: string) => boolean): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const off = client.on((method, params, sid) => {
    if (sid === sessionId && filter(method)) events.push({ method, params });
  });
  return new Promise((resolve) =>
    setTimeout(() => {
      off();
      resolve(events);
    }, ms),
  );
}

interface CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

/** Turns V8 block coverage (nested ranges, innermost wins) into the number of used bytes. */
export function usedBytes(functions: Array<{ ranges: CoverageRange[] }>): number {
  const points: Array<{ offset: number; type: 0 | 1; range: CoverageRange }> = [];
  for (const fn of functions) {
    for (const range of fn.ranges) {
      points.push({ offset: range.startOffset, type: 0, range });
      points.push({ offset: range.endOffset, type: 1, range });
    }
  }
  // At equal offsets: ends before starts; among starts the longer range first, among ends the shorter first.
  points.sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.type !== b.type) return b.type - a.type;
    const aLen = a.range.endOffset - a.range.startOffset;
    const bLen = b.range.endOffset - b.range.startOffset;
    return a.type === 0 ? bLen - aLen : aLen - bLen;
  });
  const stack: number[] = [];
  let lastOffset = 0;
  let used = 0;
  for (const p of points) {
    if (stack.length && lastOffset < p.offset && stack[stack.length - 1]! > 0) used += p.offset - lastOffset;
    lastOffset = p.offset;
    if (p.type === 0) stack.push(p.range.count);
    else stack.pop();
  }
  return used;
}

interface HeapSummary {
  nodeCount: number;
  totalSelfSize: number;
  topClasses: Array<{ name: string; count: number; selfSize: number }>;
  detachedDomNodes: number;
  detachedExamples: string[];
}

/** Aggregates a .heapsnapshot by constructor name (self sizes) and counts detached DOM nodes. */
export function summarizeHeapSnapshot(json: string): HeapSummary {
  const snap = JSON.parse(json) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
    nodes: number[];
    strings: string[];
  };
  const fields = snap.snapshot.meta.node_fields;
  const stride = fields.length;
  const iType = fields.indexOf('type');
  const iName = fields.indexOf('name');
  const iSize = fields.indexOf('self_size');
  const iDetached = fields.indexOf('detachedness');
  const types = snap.snapshot.meta.node_types[0];
  const byName = new Map<string, { count: number; selfSize: number }>();
  let total = 0;
  let detached = 0;
  const examples = new Set<string>();
  for (let i = 0; i < snap.nodes.length; i += stride) {
    const type = types[snap.nodes[i + iType]!];
    const rawName = snap.strings[snap.nodes[i + iName]!] ?? '';
    const size = snap.nodes[i + iSize]!;
    total += size;
    const name = type === 'object' || type === 'native' ? rawName : `(${type})`;
    const entry = byName.get(name) ?? { count: 0, selfSize: 0 };
    entry.count++;
    entry.selfSize += size;
    byName.set(name, entry);
    if ((iDetached >= 0 && snap.nodes[i + iDetached] === 2) || rawName.startsWith('Detached ')) {
      detached++;
      if (examples.size < 8) examples.add(rawName.replace(/^Detached /, ''));
    }
  }
  return {
    nodeCount: snap.nodes.length / stride,
    totalSelfSize: total,
    topClasses: [...byName.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.selfSize - a.selfSize).slice(0, 25),
    detachedDomNodes: detached,
    detachedExamples: [...examples],
  };
}

export function fullDevtoolsServices(ctx: BridgeContext): Record<string, ServiceHandler> {
  const client = ctx.fullCdp;
  const scriptLengths = new Map<string, { scripts: Map<string, { url: string; length: number }>; off: () => void }>();

  return {
    'fdc.status': async () => client.status(),
    'fdc.ensure': async () => {
      try {
        await client.ensure();
      } catch {
        /* status carries the reason */
      }
      return client.status();
    },
    'fdc.send': async (a) => {
      const sessionId = a.targetId ? await client.sessionFor(String(a.targetId)) : undefined;
      return client.send(String(a.method), (a.params as Record<string, unknown>) ?? {}, a.sessionId ? String(a.sessionId) : sessionId);
    },
    'fdc.heapSnapshot': async (a) => {
      const sessionId = await client.sessionFor(String(a.targetId));
      const target = resolveTarget(ctx.outputDir, a.path, 'heap', 'heapsnapshot');
      const fd = openSync(target, 'w');
      let bytes = 0;
      const off = client.on((method, params, sid) => {
        if (sid === sessionId && method === 'HeapProfiler.addHeapSnapshotChunk') {
          const buf = Buffer.from(String(params.chunk), 'utf8');
          writeSync(fd, buf);
          bytes += buf.length;
        }
      });
      try {
        await client.send('HeapProfiler.enable', {}, sessionId);
        if (a.gc !== false) await client.send('HeapProfiler.collectGarbage', {}, sessionId);
        await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false }, sessionId);
      } finally {
        off();
        closeSync(fd);
        await client.send('HeapProfiler.disable', {}, sessionId).catch(() => {});
      }
      const summary = summarizeHeapSnapshot(readFileSync(target, 'utf8'));
      return { path: target, bytes, summary };
    },
    'fdc.jsCoverage.start': async (a) => {
      const sessionId = await client.sessionFor(String(a.targetId));
      scriptLengths.get(sessionId)?.off();
      const scripts = new Map<string, { url: string; length: number }>();
      const off = client.on((method, params, sid) => {
        if (sid === sessionId && method === 'Debugger.scriptParsed' && params.url) {
          scripts.set(String(params.scriptId), { url: String(params.url), length: Number(params.length ?? 0) });
        }
      });
      scriptLengths.set(sessionId, { scripts, off });
      await client.send('Debugger.enable', {}, sessionId);
      // Never let page `debugger;` statements pause the tab while we only read sources.
      await client.send('Debugger.setSkipAllPauses', { skip: true }, sessionId);
      await client.send('Profiler.enable', {}, sessionId);
      await client.send('Profiler.startPreciseCoverage', { callCount: false, detailed: true }, sessionId);
      return { started: true };
    },
    'fdc.jsCoverage.stop': async (a) => {
      const sessionId = await client.sessionFor(String(a.targetId));
      const { result } = await client.send<{ result: Array<{ scriptId: string; url: string; functions: Array<{ ranges: CoverageRange[] }> }> }>('Profiler.takePreciseCoverage', {}, sessionId);
      await client.send('Profiler.stopPreciseCoverage', {}, sessionId).catch(() => {});
      await client.send('Profiler.disable', {}, sessionId).catch(() => {});
      const tracked = scriptLengths.get(sessionId);
      tracked?.off();
      const scripts = tracked?.scripts ?? new Map<string, { url: string; length: number }>();
      const files = [];
      for (const entry of result) {
        if (!entry.url || entry.url.startsWith('chrome-extension://')) continue;
        let total = scripts.get(entry.scriptId)?.length ?? 0;
        if (!total) {
          const src = await client.send<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId: entry.scriptId }, sessionId).catch(() => null);
          total = src?.scriptSource.length ?? 0;
        }
        if (!total) continue;
        const used = Math.min(total, usedBytes(entry.functions));
        files.push({ url: entry.url, total, used });
      }
      await client.send('Debugger.disable', {}, sessionId).catch(() => {});
      scriptLengths.delete(sessionId);
      return { files };
    },
    'fdc.media': async (a) => {
      const sessionId = await client.sessionFor(String(a.targetId));
      const collected = waitForEvents(client, sessionId, Number(a.waitMs ?? 800), (m) => m.startsWith('Media.'));
      await client.send('Media.enable', {}, sessionId);
      const events = await collected;
      await client.send('Media.disable', {}, sessionId).catch(() => {});
      return { events };
    },
  };
}

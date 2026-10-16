import { describeException, TEMP_GROUP } from '../../extension/background/page-world.ts';
import type { Feature } from '../../extension/background/types.ts';
import { ToolError, truncate } from '../../extension/background/util.ts';

/** Page function: JSON-safe copy of any value (DOM nodes, cycles, functions, Maps…). `this` is the value. */
function serializeValue(this: unknown, maxDepth: number): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: any, depth: number): unknown => {
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'string') return v.length > 10_000 ? `${v.slice(0, 10_000)}…` : v;
    if (v === undefined) return '[undefined]';
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'symbol') return v.toString();
    if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
    if (typeof Node !== 'undefined' && v instanceof Node) {
      if (v.nodeType === 1) {
        const el = v as Element;
        const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 3).join('.')}` : '';
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
        return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}>${text ? ` ${JSON.stringify(text)}` : ''}`;
      }
      return `[${v.nodeName}]`;
    }
    if (v instanceof Error) return { error: v.name, message: v.message, stack: (v.stack ?? '').split('\n').slice(0, 6).join('\n') };
    if (typeof Window !== 'undefined' && v instanceof Window) return '[Window]';
    if (seen.has(v)) return '[Circular]';
    if (depth >= maxDepth) return Array.isArray(v) ? `[Array(${v.length})]` : `[${v.constructor?.name ?? 'Object'}]`;
    seen.add(v);
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return v.toString();
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      const list = Array.from(v as ArrayLike<unknown>);
      const out = list.slice(0, 200).map((x) => walk(x, depth + 1));
      if (list.length > 200) out.push(`… ${list.length - 200} more items`);
      return out;
    }
    if (v instanceof Map) return { '[Map]': Array.from(v.entries()).slice(0, 100).map(([k, x]) => [walk(k, depth + 1), walk(x, depth + 1)]) };
    if (v instanceof Set) return { '[Set]': Array.from(v).slice(0, 200).map((x) => walk(x, depth + 1)) };
    if (typeof v.then === 'function') return '[Promise]';
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const key in v) {
      if (n++ >= 200) {
        out['…'] = 'more keys';
        break;
      }
      try {
        out[key] = walk(v[key], depth + 1);
      } catch {
        out[key] = '[unreadable]';
      }
    }
    return out;
  };
  return walk(this, 0);
}

export const scriptFeature: Feature = {
  name: 'script',
  handlers: {
    async evaluate(args: { expression?: string; function?: string; args?: unknown[]; world?: 'main' | 'isolated'; frame?: string; userGesture?: boolean; timeoutMs?: number }, { core, tabId }) {
      if (!args.expression && !args.function) throw new ToolError('Give expression or function.');
      await core.cdp.ensure(tabId);
      let sessionId: string | undefined;
      let frameId: string | undefined;
      if (args.frame) {
        const owner = core.refs.get(tabId, args.frame);
        const { node } = await core.cdp.send(tabId, 'DOM.describeNode', { backendNodeId: owner.backendNodeId }, owner.sessionId);
        if (!node.frameId) throw new ToolError(`[${owner.ref}] is not an <iframe>/<frame> element.`);
        const oopif = core.cdp.children(tabId).find((c) => c.targetId === node.frameId);
        if (oopif) sessionId = oopif.sessionId;
        else {
          sessionId = owner.sessionId;
          frameId = node.frameId;
        }
      }
      const world = args.world ?? 'main';
      const contextId = world === 'isolated' ? await core.page.isolatedContext(tabId, sessionId, frameId) : core.page.mainWorldContext(tabId, sessionId, frameId);
      const expression = args.function ? `(${args.function})(...${JSON.stringify(args.args ?? [])})` : args.expression!;
      const res = await core.cdp.send(
        tabId,
        'Runtime.evaluate',
        {
          expression,
          contextId,
          returnByValue: false,
          awaitPromise: true,
          userGesture: args.userGesture ?? false,
          replMode: !args.function,
          objectGroup: TEMP_GROUP,
          timeout: args.timeoutMs ?? 30_000,
          generatePreview: false,
        },
        sessionId,
      );
      if (res.exceptionDetails) throw new ToolError(`JavaScript error: ${describeException(res.exceptionDetails)}`);
      let r = res.result as { type: string; subtype?: string; value?: unknown; unserializableValue?: string; objectId?: string; description?: string };
      // REPL mode returns a promise value unawaited (like the DevTools console); settle it.
      if (r.subtype === 'promise' && r.objectId) {
        const settled = await core.cdp.send(tabId, 'Runtime.awaitPromise', { promiseObjectId: r.objectId, returnByValue: false }, sessionId);
        if (settled.exceptionDetails) throw new ToolError(`Promise rejected: ${describeException(settled.exceptionDetails)}`);
        r = settled.result;
      }
      let value: unknown;
      if (r.objectId) {
        const ser = await core.cdp.send(tabId, 'Runtime.callFunctionOn', { objectId: r.objectId, functionDeclaration: serializeValue.toString(), arguments: [{ value: 6 }], returnByValue: true }, sessionId);
        value = ser.exceptionDetails ? r.description : ser.result.value;
      } else if (r.unserializableValue) value = r.unserializableValue;
      else if (r.type === 'undefined') value = undefined;
      else value = r.value;
      const text = value === undefined ? 'undefined' : typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value, null, 2);
      return truncate(`${r.subtype ?? r.type}: ${text}`, 50_000, 'return a smaller value');
    },
  },
};

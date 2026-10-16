import type { Core } from '../../extension/background/core.ts';
import type { Feature } from '../../extension/background/types.ts';
import { nodeBox } from '../../extension/background/geometry.ts';
import { ToolError, truncate, withTimeout } from '../../extension/background/util.ts';
import { collectFrames, nodeName, role, type AXNode, type FrameAX } from '../../extension/background/ax.ts';
import { renderTree } from './render.ts';
import { findTextElements, pageMarkdown, querySelectorDeep, xpathElements } from './page.ts';

/** Viewport filter for page_snapshot(viewportOnly): boxes of the main document plus per-frame visibility. */
async function viewportFilter(core: Core, tabId: number, frames: FrameAX[]): Promise<(frame: FrameAX, backendNodeId?: number) => boolean | undefined> {
  const snap = await core.cdp.send(tabId, 'DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: false });
  const strings: string[] = snap.strings;
  const mainFrameId = await core.page.mainFrameId(tabId);
  const doc = (snap.documents as any[]).find((d) => strings[d.frameId] === mainFrameId) ?? snap.documents[0];
  const boxes = new Map<number, number[]>();
  (doc.layout.nodeIndex as number[]).forEach((nodeIndex, i) => boxes.set(doc.nodes.backendNodeId[nodeIndex], doc.layout.bounds[i]));
  const { cssVisualViewport: vv } = await core.cdp.send(tabId, 'Page.getLayoutMetrics');
  const inView = (b: number[]) => b[2]! > 0 && b[3]! > 0 && b[0]! < vv.pageX + vv.clientWidth && b[0]! + b[2]! > vv.pageX && b[1]! < vv.pageY + vv.clientHeight && b[1]! + b[3]! > vv.pageY;
  const main = frames.find((f) => !f.owner);
  const frameVisible = new Map<FrameAX, boolean>();
  const visibleFrame = (f: FrameAX): boolean => {
    const cached = frameVisible.get(f);
    if (cached !== undefined) return cached;
    let v = true;
    if (f.owner) {
      const container = frames.find((p) => (p.sessionId ?? '') === (f.owner!.sessionId ?? '') && [...p.nodes.values()].some((n) => n.backendDOMNodeId === f.owner!.backendNodeId));
      if (container === main) {
        const b = boxes.get(f.owner.backendNodeId);
        v = b ? inView(b) : true;
      } else if (container) v = visibleFrame(container);
    }
    frameVisible.set(f, v);
    return v;
  };
  return (frame, backendNodeId) => {
    if (frame !== main) return visibleFrame(frame);
    if (backendNodeId === undefined) return undefined;
    const b = boxes.get(backendNodeId);
    return b ? inView(b) : undefined;
  };
}

interface FoundNode {
  sessionId?: string;
  frameId?: string;
  backendNodeId: number;
}

async function describeFound(core: Core, tabId: number, found: FoundNode[]): Promise<string[]> {
  const lines: string[] = [];
  for (const f of found) {
    let r = '';
    let name = '';
    let frameId = f.frameId;
    try {
      const { nodes } = await core.cdp.send(tabId, 'Accessibility.getPartialAXTree', { backendNodeId: f.backendNodeId, fetchRelatives: false }, f.sessionId);
      const ax = (nodes as AXNode[]).find((n) => n.backendDOMNodeId === f.backendNodeId) ?? nodes[0];
      if (ax) {
        r = role(ax);
        name = nodeName(ax);
        frameId = ax.frameId ?? frameId;
      }
    } catch {
      /* not in the accessibility tree */
    }
    const { node } = await core.cdp.send(tabId, 'DOM.describeNode', { backendNodeId: f.backendNodeId }, f.sessionId);
    const tag = String(node.localName || node.nodeName).toLowerCase();
    const entry = core.refs.register({ tabId, sessionId: f.sessionId, frameId, backendNodeId: f.backendNodeId }, { role: r || tag, name });
    const box = await nodeBox(core.cdp, entry).catch(() => null);
    const where = box ? ` at (${Math.round(box.x)},${Math.round(box.y)}) ${Math.round(box.width)}×${Math.round(box.height)}` : ' (not rendered)';
    lines.push(`- [ref=${entry.ref}] ${r || tag}${name ? ` ${JSON.stringify(name.length > 100 ? `${name.slice(0, 99)}…` : name)}` : ''} <${tag}>${where}${f.sessionId ? ' (in iframe)' : ''}`);
  }
  return lines;
}

export const snapshotFeature: Feature = {
  name: 'snapshot',
  handlers: {
    async page_snapshot(args: { interactiveOnly?: boolean; viewportOnly?: boolean; root?: string; maxChars?: number }, { core, tabId }) {
      await core.cdp.ensure(tabId);
      const frames = await collectFrames(core, tabId);
      const visible = args.viewportOnly ? await viewportFilter(core, tabId, frames) : undefined;
      let rootBackendId: { sessionId?: string; backendNodeId: number } | undefined;
      if (args.root) {
        const entry = core.refs.get(tabId, args.root);
        rootBackendId = { sessionId: entry.sessionId, backendNodeId: entry.backendNodeId };
      }
      const { text, refs } = renderTree(core, tabId, frames, { interactiveOnly: args.interactiveOnly, visible, rootBackendId });
      const tab = await chrome.tabs.get(tabId);
      const dialog = core.life.dialog(tabId);
      const header = [
        `Page: ${tab.title || '(no title)'} — ${tab.url}`,
        `${refs.length} refs${args.viewportOnly ? ' in the viewport' : ''}. Interact with click/type/fill_form/select_option using ref=…`,
        dialog ? `A ${dialog.type} dialog is open: "${dialog.message}" — handle it with the dialog tool.` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return truncate(`${header}\n${text}`, args.maxChars ?? 30_000, 'narrow it with interactiveOnly=true, viewportOnly=true or root=<ref of a section>');
    },

    async page_read(args: { ref?: string; selector?: string; mainOnly?: boolean; includeImages?: boolean; offset?: number; maxChars?: number }, { core, tabId }) {
      await core.cdp.ensure(tabId);
      const opts = { selector: args.selector, mainOnly: args.mainOnly, includeImages: args.includeImages };
      const markdown = args.ref ? await core.page.callOn<string>(core.refs.get(tabId, args.ref), pageMarkdown, [opts]) : await core.page.evaluate<string>(tabId, pageMarkdown, [opts]);
      if (args.selector && !markdown) throw new ToolError(`Nothing matched selector ${args.selector} (or it has no visible text).`);
      const offset = Math.max(0, args.offset ?? 0);
      const max = args.maxChars ?? 20_000;
      const slice = markdown.slice(offset, offset + max);
      const rest = markdown.length - offset - slice.length;
      const tab = await chrome.tabs.get(tabId);
      return `# ${tab.title || tab.url}\n<${tab.url}>${offset ? ` (from character ${offset})` : ''}\n\n${slice}${rest > 0 ? `\n\n[${rest} more characters — call page_read with offset=${offset + slice.length}]` : ''}`;
    },

    async find(args: { text?: string; selector?: string; xpath?: string; role?: string; name?: string; limit?: number }, { core, tabId }) {
      if (!args.text && !args.selector && !args.xpath && !args.role && !args.name) throw new ToolError('Give text, selector, xpath or role/name.');
      await core.cdp.ensure(tabId);
      const limit = args.limit ?? 20;
      const found: FoundNode[] = [];
      if (args.role || (args.name && !args.text && !args.selector && !args.xpath)) {
        // Filter Chrome's full accessibility trees: Accessibility.queryAXTree never answers in
        // out-of-process iframe sessions (Chrome 155), getFullAXTree does.
        const wantRole = args.role?.toLowerCase();
        const wantName = args.name?.toLowerCase();
        const frames = await collectFrames(core, tabId);
        const matches = (exact: boolean) => {
          const out: FoundNode[] = [];
          for (const f of frames) {
            for (const n of f.nodes.values()) {
              if (n.ignored || n.backendDOMNodeId === undefined) continue;
              if (wantRole && role(n).toLowerCase() !== wantRole) continue;
              if (wantName) {
                const name = nodeName(n).toLowerCase();
                if (exact ? name !== wantName : !name.includes(wantName)) continue;
              }
              out.push({ sessionId: f.sessionId, frameId: n.frameId ?? f.frameId, backendNodeId: n.backendDOMNodeId });
            }
          }
          return out;
        };
        const exact = matches(true);
        found.push(...(exact.length || !wantName ? exact : matches(false)).slice(0, limit));
      } else {
        const sessions: Array<string | undefined> = [undefined, ...core.cdp.children(tabId).filter((c) => c.type === 'iframe').map((c) => c.sessionId)];
        const fn = args.text ? findTextElements : args.selector ? querySelectorDeep : xpathElements;
        const query = args.text ?? args.selector ?? args.xpath!;
        for (const sessionId of sessions) {
          if (found.length >= limit) break;
          try {
            const nodes = await withTimeout(core.page.elementsFrom(tabId, fn, [query, limit - found.length], { sessionId }), 10_000, 'frame search timed out');
            for (const n of nodes) found.push({ sessionId, ...n });
          } catch (error) {
            if (!sessionId) throw error; // iframe failures are not fatal
          }
        }
      }
      if (!found.length) return `No element matches ${JSON.stringify(args)}.`;
      const lines = await describeFound(core, tabId, found.slice(0, limit));
      return `${lines.length} match${lines.length === 1 ? '' : 'es'}:\n${lines.join('\n')}`;
    },
  },
};

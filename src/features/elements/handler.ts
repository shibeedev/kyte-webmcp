import type { Core } from '../../extension/background/core.ts';
import type { RefEntry } from '../../extension/background/refs.ts';
import type { Feature } from '../../extension/background/types.ts';
import { ToolError, truncate } from '../../extension/background/util.ts';

const COMMON_COMPUTED = [
  'display', 'position', 'top', 'left', 'right', 'bottom', 'z-index', 'width', 'height', 'min-width', 'max-width', 'margin', 'padding', 'box-sizing',
  'color', 'background-color', 'background-image', 'opacity', 'visibility', 'overflow', 'font-family', 'font-size', 'font-weight', 'line-height',
  'text-align', 'border', 'border-radius', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'transform', 'cursor', 'pointer-events',
];

const sheetUrls = new Map<number, Map<string, { url: string; startLine: number }>>();

/** Page function: first element matching a selector, piercing open shadow roots. */
function deepQuery(selector: string): Element[] {
  const visit = (root: ParentNode): Element | null => {
    const hit = root.querySelector(selector);
    if (hit) return hit;
    for (const e of Array.from(root.querySelectorAll('*'))) {
      const sr = (e as HTMLElement).shadowRoot;
      if (sr) {
        const found = visit(sr);
        if (found) return found;
      }
    }
    return null;
  };
  const el = visit(document);
  return el ? [el] : [];
}

async function nodeIdFor(core: Core, entry: RefEntry): Promise<number> {
  await core.cdp.send(entry.tabId, 'DOM.getDocument', { depth: 0 }, entry.sessionId);
  const { nodeIds } = await core.cdp.send(entry.tabId, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [entry.backendNodeId] }, entry.sessionId);
  if (!nodeIds?.[0]) throw new ToolError('The element is no longer in the document.');
  return nodeIds[0];
}

function boxSummary(model: { content: number[]; padding: number[]; border: number[]; margin: number[]; width: number; height: number }): string {
  const side = (outer: number[], inner: number[]) => ({ top: inner[1]! - outer[1]!, right: outer[2]! - inner[2]!, bottom: outer[5]! - inner[5]!, left: inner[0]! - outer[0]! });
  const fmt = (s: { top: number; right: number; bottom: number; left: number }) => [s.top, s.right, s.bottom, s.left].map((n) => Math.round(n * 10) / 10).join(' ');
  return `${Math.round(model.width)}×${Math.round(model.height)} at (${Math.round(model.border[0]!)},${Math.round(model.border[1]!)}) · margin ${fmt(side(model.margin, model.border))} · border ${fmt(side(model.border, model.padding))} · padding ${fmt(side(model.padding, model.content))}`;
}

interface CssProperty {
  name: string;
  value: string;
  important?: boolean;
  disabled?: boolean;
  implicit?: boolean;
  parsedOk?: boolean;
  range?: unknown;
}

function styleText(props: CssProperty[]): string {
  // CDP lists authored declarations (with a source range) plus their longhand expansions; show what was written.
  const authored = props.some((p) => p.range) ? props.filter((p) => p.range) : props;
  return authored
    .filter((p) => !p.disabled && !p.implicit && p.value !== undefined)
    .map((p) => `${p.name}: ${p.value}${p.important ? ' !important' : ''}${p.parsedOk === false ? ' /* invalid */' : ''}`)
    .join('; ');
}

export const elementsFeature: Feature = {
  name: 'elements',
  setup(core) {
    core.cdp.on((tabId, sessionId, method, params) => {
      if (method !== 'CSS.styleSheetAdded') return;
      const key = tabId;
      let map = sheetUrls.get(key);
      if (!map) sheetUrls.set(key, (map = new Map()));
      map.set(`${sessionId ?? ''}:${params.header.styleSheetId}`, { url: params.header.sourceURL || '(inline style)', startLine: params.header.startLine ?? 0 });
    });
    chrome.tabs.onRemoved.addListener((tabId) => sheetUrls.delete(tabId));
  },
  handlers: {
    async dom_inspect(args: { ref?: string; selector?: string; include?: string[]; allComputed?: boolean }, { core, tabId }) {
      await core.cdp.ensure(tabId);
      let entry: RefEntry;
      if (args.ref) entry = core.refs.get(tabId, args.ref);
      else if (args.selector) {
        const [found] = await core.page.elementsFrom(tabId, deepQuery, [args.selector]);
        if (!found) throw new ToolError(`No element matches ${args.selector}.`);
        entry = core.refs.register({ tabId, ...found });
      } else throw new ToolError('Give a ref or a selector.');
      const include = new Set(args.include?.length ? args.include : ['html', 'attributes', 'box', 'computed', 'rules', 'listeners', 'accessibility']);
      const s = entry.sessionId;
      const { node } = await core.cdp.send(tabId, 'DOM.describeNode', { backendNodeId: entry.backendNodeId }, s);
      const out: string[] = [`[${entry.ref}] <${String(node.localName || node.nodeName).toLowerCase()}>${entry.sessionId ? ' (inside an out-of-process iframe)' : ''}`];
      if (include.has('attributes')) {
        const attrs: string[] = node.attributes ?? [];
        const pairs: string[] = [];
        for (let i = 0; i < attrs.length; i += 2) pairs.push(`${attrs[i]}="${String(attrs[i + 1]).slice(0, 200)}"`);
        out.push(`Attributes: ${pairs.join(' ') || '(none)'}`);
      }
      if (include.has('html')) {
        const { outerHTML } = await core.cdp.send(tabId, 'DOM.getOuterHTML', { backendNodeId: entry.backendNodeId }, s);
        out.push(`HTML:\n${truncate(outerHTML, 4000)}`);
      }
      if (include.has('box')) {
        try {
          const { model } = await core.cdp.send(tabId, 'DOM.getBoxModel', { backendNodeId: entry.backendNodeId }, s);
          out.push(`Box: ${boxSummary(model)}`);
        } catch {
          out.push('Box: not rendered (display: none or detached)');
        }
      }
      if (include.has('computed') || include.has('rules')) {
        await core.cdp.send(tabId, 'DOM.enable', {}, s);
        await core.cdp.send(tabId, 'CSS.enable', {}, s);
        const nodeId = await nodeIdFor(core, entry);
        if (include.has('computed')) {
          const { computedStyle } = await core.cdp.send(tabId, 'CSS.getComputedStyleForNode', { nodeId }, s);
          const props = (computedStyle as Array<{ name: string; value: string }>).filter((p) => args.allComputed || COMMON_COMPUTED.includes(p.name));
          out.push(`Computed style${args.allComputed ? '' : ' (common properties)'}:\n${props.map((p) => `  ${p.name}: ${p.value}`).join('\n')}`);
        }
        if (include.has('rules')) {
          const matched = await core.cdp.send(tabId, 'CSS.getMatchedStylesForNode', { nodeId }, s);
          const where = (styleSheetId: string | undefined, range?: { startLine: number }) => {
            if (!styleSheetId) return '';
            const info = sheetUrls.get(tabId)?.get(`${s ?? ''}:${styleSheetId}`);
            return info ? ` (${info.url}${range ? `:${info.startLine + range.startLine + 1}` : ''})` : '';
          };
          const lines: string[] = [];
          if (matched.inlineStyle?.cssProperties?.length) lines.push(`  element.style { ${styleText(matched.inlineStyle.cssProperties)} }`);
          let uaRules = 0;
          for (const m of [...(matched.matchedCSSRules ?? [])].reverse()) {
            const rule = m.rule;
            if (rule.origin === 'user-agent') {
              uaRules++;
              continue;
            }
            lines.push(`  ${rule.selectorList.text} { ${styleText(rule.style.cssProperties)} }${where(rule.styleSheetId, rule.style.range)}`);
          }
          if (uaRules) lines.push(`  (+ ${uaRules} user-agent rules)`);
          (matched.inherited ?? []).slice(0, 3).forEach((inh: any, i: number) => {
            const rules = (inh.matchedCSSRules ?? []).filter((m: any) => m.rule.origin !== 'user-agent');
            if (!rules.length && !inh.inlineStyle?.cssProperties?.length) return;
            lines.push(`  inherited from ancestor ${i + 1}:`);
            for (const m of [...rules].reverse()) lines.push(`    ${m.rule.selectorList.text} { ${styleText(m.rule.style.cssProperties)} }${where(m.rule.styleSheetId, m.rule.style.range)}`);
          });
          out.push(`Matched CSS rules (winning first):\n${lines.join('\n') || '  (none)'}`);
        }
      }
      if (include.has('listeners')) {
        const objectId = await core.page.resolve(entry, 'main');
        const { listeners } = await core.cdp.send(tabId, 'DOMDebugger.getEventListeners', { objectId, depth: 0 }, s);
        const list = (listeners as Array<{ type: string; useCapture: boolean; passive: boolean; once: boolean; lineNumber: number; columnNumber: number; handler?: { description?: string } }>).map(
          (l) => `  ${l.type}${l.useCapture ? ' (capture)' : ''}${l.passive ? ' (passive)' : ''}${l.once ? ' (once)' : ''} → ${(l.handler?.description ?? 'function').split('\n')[0]!.slice(0, 120)} @${l.lineNumber + 1}:${l.columnNumber + 1}`,
        );
        out.push(`Event listeners on the element:\n${list.join('\n') || '  (none)'}`);
      }
      if (include.has('accessibility')) {
        const { nodes } = await core.cdp.send(tabId, 'Accessibility.getPartialAXTree', { backendNodeId: entry.backendNodeId, fetchRelatives: false }, s);
        const ax = (nodes as any[]).find((n) => n.backendDOMNodeId === entry.backendNodeId) ?? nodes[0];
        if (ax) {
          const props = (ax.properties ?? []).map((p: any) => `${p.name}=${JSON.stringify(p.value?.value)}`).join(' ');
          out.push(`Accessibility: role ${ax.role?.value ?? '?'}, name ${JSON.stringify(ax.name?.value ?? '')}${ax.description?.value ? `, description ${JSON.stringify(ax.description.value)}` : ''}${ax.ignored ? ' (ignored)' : ''}${props ? ` · ${props}` : ''}`);
        }
      }
      return out.join('\n');
    },
  },
};

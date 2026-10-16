/** Chrome accessibility trees of every frame of a tab (shared by snapshot, screenshot annotation and the agent-readiness audit). */
import type { Core } from './core.ts';
import { withTimeout } from './util.ts';

/** A frame that never answers must not hang the whole snapshot. */
const FRAME_TIMEOUT_MS = 8000;

export interface AXValue {
  type: string;
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface FrameAX {
  sessionId?: string;
  frameId: string;
  nodes: Map<string, AXNode>;
  rootId: string;
  /** Backend id of the <iframe> element in the parent document, and the session it lives in. */
  owner?: { sessionId?: string; backendNodeId: number };
}

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'textField', 'TextField', 'ToggleButton', 'PopUpButton',
  'ColorWell', 'Date', 'DateTime', 'InputTime', 'DisclosureTriangle', 'scrollbar', 'gridcell', 'columnheader',
]);
/** Generic wrappers that carry no meaning of their own. */
export const SKIP_ROLES = new Set(['none', 'presentation', 'generic', 'LineBreak', 'InlineTextBox', 'ListMarker', 'GenericContainer', 'Ruby', 'Section', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell']);

export function role(node: AXNode): string {
  return String(node.role?.value ?? '');
}

export function nodeName(node: AXNode): string {
  return String(node.name?.value ?? '').replace(/\s+/g, ' ').trim();
}

export function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

export function isInteractive(node: AXNode): boolean {
  const r = role(node);
  if (INTERACTIVE_ROLES.has(r)) return true;
  return prop(node, 'focusable') === true && !SKIP_ROLES.has(r) && r !== 'RootWebArea' && r !== 'StaticText' && !!nodeName(node);
}

/** Collects Chrome's accessibility trees of every frame of the tab (same-process and out-of-process). */
export async function collectFrames(core: Core, tabId: number): Promise<FrameAX[]> {
  const sessions: Array<{ sessionId?: string; parentSessionId?: string; targetId?: string }> = [{}];
  for (const child of core.cdp.children(tabId)) if (child.type === 'iframe') sessions.push({ sessionId: child.sessionId, parentSessionId: child.parentSessionId, targetId: child.targetId });
  const frames: FrameAX[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    let tree: { frameTree: { frame: { id: string }; childFrames?: unknown[] } };
    try {
      tree = await withTimeout(core.cdp.send(tabId, 'Page.getFrameTree', {}, s.sessionId), FRAME_TIMEOUT_MS, 'frame tree timed out');
    } catch {
      continue;
    }
    const ids: Array<{ id: string; parentId?: string }> = [];
    const walk = (n: { frame: { id: string }; childFrames?: unknown[] }, parentId?: string) => {
      ids.push({ id: n.frame.id, parentId });
      for (const c of (n.childFrames ?? []) as Array<typeof n>) walk(c, n.frame.id);
    };
    walk(tree.frameTree);
    for (const { id, parentId } of ids) {
      if (seen.has(id)) continue;
      let nodes: AXNode[];
      try {
        ({ nodes } = await withTimeout(core.cdp.send(tabId, 'Accessibility.getFullAXTree', { frameId: id }, s.sessionId), s.sessionId ? FRAME_TIMEOUT_MS : 30_000, 'accessibility tree timed out'));
      } catch {
        continue;
      }
      if (!nodes.length) continue;
      const root = nodes.find((n) => !n.parentId) ?? nodes[0]!;
      const frame: FrameAX = { sessionId: s.sessionId, frameId: id, nodes: new Map(nodes.map((n) => [n.nodeId, n])), rootId: root.nodeId };
      // Owner <iframe>: same session for same-process children, parent session for an OOPIF's root frame.
      const isOopifRoot = s.sessionId !== undefined && id === s.targetId;
      if (parentId || isOopifRoot) {
        const ownerSession = isOopifRoot ? s.parentSessionId : s.sessionId;
        try {
          const owner = await withTimeout(core.cdp.send(tabId, 'DOM.getFrameOwner', { frameId: id }, ownerSession), FRAME_TIMEOUT_MS, 'frame owner timed out');
          frame.owner = { sessionId: ownerSession, backendNodeId: owner.backendNodeId };
        } catch {
          /* detached frame */
        }
      }
      seen.add(id);
      frames.push(frame);
    }
  }
  return frames;
}


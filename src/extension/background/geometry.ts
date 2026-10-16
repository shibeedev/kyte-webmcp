import type { Cdp } from './cdp.ts';
import type { NodeRef } from './page-world.ts';
import { ToolError } from './util.ts';

export type Quad = number[];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function quadBounds(q: Quad): Box {
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function quadArea(q: Quad): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += q[i * 2]! * q[j * 2 + 1]! - q[j * 2]! * q[i * 2 + 1]!;
  }
  return Math.abs(area / 2);
}

/** Viewport offset of an out-of-process iframe session (sum over nested frames). */
export async function frameOffset(cdp: Cdp, tabId: number, sessionId?: string): Promise<{ x: number; y: number }> {
  if (!sessionId) return { x: 0, y: 0 };
  const child = cdp.child(tabId, sessionId);
  if (!child) throw new ToolError('That frame is gone. Take a new page_snapshot.');
  const owner = await cdp.send(tabId, 'DOM.getFrameOwner', { frameId: child.targetId }, child.parentSessionId);
  const { model } = await cdp.send(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, child.parentSessionId);
  const up = await frameOffset(cdp, tabId, child.parentSessionId);
  return { x: model.content[0] + up.x, y: model.content[1] + up.y };
}

/** False when the node was removed from its document (it can live on detached, with no layout). */
async function isConnected(cdp: Cdp, node: NodeRef): Promise<boolean> {
  try {
    const { object } = await cdp.send(node.tabId, 'DOM.resolveNode', { backendNodeId: node.backendNodeId }, node.sessionId);
    const res = await cdp.send(node.tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return this.isConnected; }', returnByValue: true }, node.sessionId);
    await cdp.send(node.tabId, 'Runtime.releaseObject', { objectId: object.objectId }, node.sessionId).catch(() => {});
    return res.result?.value !== false;
  } catch {
    return false;
  }
}

/** Content quads of a node in top-level viewport CSS pixels. */
export async function nodeQuads(cdp: Cdp, node: NodeRef): Promise<Quad[]> {
  let quads: Quad[];
  try {
    ({ quads } = await cdp.send(node.tabId, 'DOM.getContentQuads', { backendNodeId: node.backendNodeId }, node.sessionId));
  } catch {
    throw new ToolError('That element no longer exists or is not rendered. Take a new page_snapshot.');
  }
  if (!quads.length && !(await isConnected(cdp, node))) throw new ToolError('That element no longer exists (it was removed from the page). Take a new page_snapshot and use the new refs.');
  if (!node.sessionId) return quads;
  const off = await frameOffset(cdp, node.tabId, node.sessionId);
  return quads.map((q) => q.map((v, i) => v + (i % 2 === 0 ? off.x : off.y)));
}

export async function nodeBox(cdp: Cdp, node: NodeRef): Promise<Box | null> {
  const quads = (await nodeQuads(cdp, node)).filter((q) => quadArea(q) > 1);
  if (!quads.length) return null;
  const boxes = quads.map(quadBounds);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

export interface ClickPoint {
  x: number;
  y: number;
  /** Set when another element sits on top of the target at that point. */
  coveredBy?: string;
}

async function describe(cdp: Cdp, tabId: number, backendNodeId: number): Promise<string> {
  const { node } = await cdp.send(tabId, 'DOM.describeNode', { backendNodeId });
  const attrs: string[] = node.attributes ?? [];
  const get = (n: string) => {
    const i = attrs.indexOf(n);
    return i >= 0 ? attrs[i + 1] : undefined;
  };
  const id = get('id');
  const cls = get('class')?.trim().split(/\s+/).slice(0, 2).join('.');
  return `<${String(node.nodeName).toLowerCase()}${id ? `#${id}` : ''}${cls ? `.${cls}` : ''}>`;
}

/** Scrolls the node into view and returns the center of its largest visible quad, with a hit test. */
export async function clickablePoint(cdp: Cdp, node: NodeRef): Promise<ClickPoint> {
  await cdp.send(node.tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }, node.sessionId).catch(() => {});
  const quads = (await nodeQuads(cdp, node)).filter((q) => quadArea(q) > 1);
  if (!quads.length) throw new ToolError('The element is not visible (it has no size on screen). It may be hidden or collapsed.');
  const { cssLayoutViewport } = await cdp.send(node.tabId, 'Page.getLayoutMetrics');
  const vw = cssLayoutViewport?.clientWidth ?? 10_000;
  const vh = cssLayoutViewport?.clientHeight ?? 10_000;
  // Prefer the part of the element that is inside the viewport.
  const best = quads
    .map((q) => {
      const b = quadBounds(q);
      const x0 = Math.max(b.x, 0);
      const y0 = Math.max(b.y, 0);
      const x1 = Math.min(b.x + b.width, vw);
      const y1 = Math.min(b.y + b.height, vh);
      return { b, visible: Math.max(0, x1 - x0) * Math.max(0, y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    })
    .sort((a, b) => b.visible - a.visible)[0]!;
  const point: ClickPoint = best.visible > 0 ? { x: best.cx, y: best.cy } : { x: best.b.x + best.b.width / 2, y: best.b.y + best.b.height / 2 };
  if (!node.sessionId) {
    try {
      const hit = await cdp.send(node.tabId, 'DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true });
      if (hit.backendNodeId !== node.backendNodeId) {
        const inside = await isInside(cdp, node, hit.backendNodeId);
        if (!inside) point.coveredBy = await describe(cdp, node.tabId, hit.backendNodeId);
      }
    } catch {
      /* hit testing is best effort */
    }
  }
  return point;
}

async function isInside(cdp: Cdp, node: NodeRef, otherBackendId: number): Promise<boolean> {
  const a = await cdp.send(node.tabId, 'DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: 'neo-webmcp-call' });
  const b = await cdp.send(node.tabId, 'DOM.resolveNode', { backendNodeId: otherBackendId, objectGroup: 'neo-webmcp-call' });
  const res = await cdp.send(node.tabId, 'Runtime.callFunctionOn', {
    objectId: a.object.objectId,
    // Our own indicator (pointer-events: none, in a closed shadow root) never blocks clicks.
    functionDeclaration:
      'function(other){ const root = other.getRootNode && other.getRootNode(); if (root && root.host && root.host.tagName === "NEO-WEBMCP-INDICATOR") return true; if (other.tagName === "NEO-WEBMCP-INDICATOR") return true; return this === other || this.contains(other) || (root && root.host && this.contains(root.host)) || (other.contains && other.contains(this) && other.tagName === "LABEL"); }',
    arguments: [{ objectId: b.object.objectId }],
    returnByValue: true,
  });
  return !!res.result.value;
}

import type { Core } from '../../extension/background/core.ts';
import type { RefEntry } from '../../extension/background/refs.ts';
import { SKIP_ROLES, isInteractive, nodeName, prop, role, type AXNode, type FrameAX } from '../../extension/background/ax.ts';

/** Non-interactive nodes that still get refs because tools target them (screenshots, media, inspection). */
const REF_ROLES = new Set(['heading', 'img', 'image', 'video', 'audio', 'Iframe', 'IframePresentational', 'dialog', 'alertdialog', 'figure', 'table', 'form', 'main', 'navigation', 'region', 'article']);
const STATE_PROPS = ['focused', 'disabled', 'checked', 'pressed', 'expanded', 'selected', 'required', 'invalid', 'readonly', 'modal', 'multiselectable', 'level', 'haspopup', 'busy'];

function wantsRef(node: AXNode): boolean {
  return isInteractive(node) || REF_ROLES.has(role(node));
}

function quote(text: string, max: number): string {
  const t = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return JSON.stringify(t);
}

function states(node: AXNode): string {
  const out: string[] = [];
  for (const name of STATE_PROPS) {
    const v = prop(node, name);
    if (v === undefined || v === false || v === 'false' || v === '') continue;
    if (name === 'focused' || name === 'disabled' || name === 'required' || name === 'readonly' || name === 'modal' || name === 'busy') {
      if (v === true || v === 'true') out.push(`[${name}]`);
    } else if (name === 'invalid') out.push('[invalid]');
    else out.push(v === true || v === 'true' ? `[${name}]` : `[${name}=${v}]`);
  }
  return out.join(' ');
}

export interface RenderOptions {
  interactiveOnly?: boolean;
  /** true/false when the node's box is known to be inside/outside the viewport, undefined when it has no box. */
  visible?: (frame: FrameAX, backendNodeId: number | undefined) => boolean | undefined;
  rootBackendId?: { sessionId?: string; backendNodeId: number };
}

/** Renders the stitched trees as an indented, YAML-like outline and registers refs. */
export function renderTree(core: Core, tabId: number, frames: FrameAX[], opts: RenderOptions): { text: string; refs: RefEntry[] } {
  const lines: string[] = [];
  const refs: RefEntry[] = [];
  const byOwner = new Map<string, FrameAX>();
  for (const f of frames) if (f.owner) byOwner.set(`${f.owner.sessionId ?? ''}:${f.owner.backendNodeId}`, f);
  const main = frames.find((f) => !f.owner) ?? frames[0];
  if (!main) return { text: '(the page has no accessibility tree yet)', refs };

  const refFor = (frame: FrameAX, node: AXNode): string | undefined => {
    if (node.backendDOMNodeId === undefined || !wantsRef(node)) return undefined;
    const entry = core.refs.register({ tabId, sessionId: frame.sessionId, frameId: node.frameId ?? frame.frameId, backendNodeId: node.backendDOMNodeId }, { role: role(node), name: nodeName(node) });
    refs.push(entry);
    return entry.ref;
  };

  const visibleMemo = new Map<string, boolean>();
  /** A node is shown when its own box is in view, or (box missing/off-screen) when a descendant is. */
  const isVisible = (frame: FrameAX, node: AXNode): boolean => {
    if (!opts.visible) return true;
    const key = `${frame.frameId}:${node.nodeId}`;
    const cached = visibleMemo.get(key);
    if (cached !== undefined) return cached;
    visibleMemo.set(key, false); // cycle guard
    const own = opts.visible(frame, node.backendDOMNodeId);
    let v = own === true;
    if (!v) {
      v = (node.childIds ?? []).some((id) => {
        const c = frame.nodes.get(id);
        return c ? isVisible(frame, c) : false;
      });
    }
    if (!v && own === undefined && node.backendDOMNodeId !== undefined) {
      const sub = byOwner.get(`${frame.sessionId ?? ''}:${node.backendDOMNodeId}`);
      if (sub) v = isVisible(sub, sub.nodes.get(sub.rootId)!);
    }
    visibleMemo.set(key, v);
    return v;
  };

  const emit = (frame: FrameAX, node: AXNode, depth: number): void => {
    if (!isVisible(frame, node)) return;
    const r = role(node);
    const name = nodeName(node);
    const children = (node.childIds ?? []).map((id) => frame.nodes.get(id)).filter((c): c is AXNode => !!c);
    const sub = node.backendDOMNodeId !== undefined ? byOwner.get(`${frame.sessionId ?? ''}:${node.backendDOMNodeId}`) : undefined;
    const pad = '  '.repeat(depth);

    if (opts.interactiveOnly) {
      if (!node.ignored && isInteractive(node)) {
        const ref = refFor(frame, node);
        const value = node.value?.value !== undefined && node.value.value !== '' ? `: ${quote(String(node.value.value), 80)}` : '';
        lines.push(`- ${r} ${name ? `${quote(name, 100)} ` : ''}${ref ? `[ref=${ref}]` : ''} ${states(node)}${value}`.replace(/\s+$/, ''));
      }
      for (const c of children) emit(frame, c, depth);
      if (sub) emit(sub, sub.nodes.get(sub.rootId)!, depth);
      return;
    }

    if (node.ignored || (SKIP_ROLES.has(r) && !name && !isInteractive(node))) {
      for (const c of children) emit(frame, c, depth);
      if (sub) emit(sub, sub.nodes.get(sub.rootId)!, depth);
      return;
    }
    if (r === 'StaticText') {
      if (name) lines.push(`${pad}- text: ${quote(name, 300)}`);
      return;
    }
    if (r === 'RootWebArea') {
      if (frame !== main || depth > 0) lines.push(`${pad}- document ${quote(name, 100)}`);
      for (const c of children) emit(frame, c, frame !== main || depth > 0 ? depth + 1 : depth);
      return;
    }
    // Collapse "role → single text child" into one line.
    const onlyText = children.length > 0 && children.every((c) => role(c) === 'StaticText' || (c.ignored && !(c.childIds ?? []).length));
    const text = onlyText ? children.map(nodeName).filter(Boolean).join(' ') : '';
    const ref = refFor(frame, node);
    const value = node.value?.value !== undefined && node.value.value !== '' && !['link', 'heading'].includes(r) ? ` value=${quote(String(node.value.value), 120)}` : '';
    const url = r === 'link' ? prop(node, 'url') : undefined;
    const label = name || (text && !onlyText ? text : '');
    let line = `${pad}- ${r}${label ? ` ${quote(label, 150)}` : ''}${ref ? ` [ref=${ref}]` : ''}${states(node) ? ` ${states(node)}` : ''}${value}`;
    if (url && typeof url === 'string') line += ` → ${url.length > 100 ? `${url.slice(0, 99)}…` : url}`;
    if (onlyText && text && text !== name) line += `: ${quote(text, 300)}`;
    lines.push(line);
    if (!onlyText) for (const c of children) emit(frame, c, depth + 1);
    if (sub) emit(sub, sub.nodes.get(sub.rootId)!, depth + 1);
  };

  let start: { frame: FrameAX; node: AXNode } | undefined;
  if (opts.rootBackendId) {
    for (const f of frames) {
      if ((f.sessionId ?? '') !== (opts.rootBackendId.sessionId ?? '')) continue;
      for (const n of f.nodes.values()) {
        if (n.backendDOMNodeId === opts.rootBackendId.backendNodeId) {
          start = { frame: f, node: n };
          break;
        }
      }
      if (start) break;
    }
  }
  if (start) emit(start.frame, start.node, 0);
  else emit(main, main.nodes.get(main.rootId)!, 0);
  return { text: lines.join('\n'), refs };
}

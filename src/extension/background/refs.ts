import type { Cdp } from './cdp.ts';
import type { NodeRef } from './page-world.ts';
import { ToolError } from './util.ts';

export interface RefEntry extends NodeRef {
  ref: string;
  role?: string;
  name?: string;
}

interface TabRefs {
  next: number;
  byKey: Map<string, RefEntry>;
  byRef: Map<string, RefEntry>;
}

/**
 * Short element handles ("e12") shared by every tool. A ref is bound to a
 * DOM node (backend node id + frame session), stays the same across
 * snapshots while the node lives, and is cleared when the page navigates.
 */
export class Refs {
  readonly #tabs = new Map<number, TabRefs>();

  constructor(cdp: Cdp) {
    cdp.on((tabId, sessionId, method, params) => {
      if (method === 'Page.frameNavigated' && !sessionId && !params.frame.parentId) this.clear(tabId);
    });
    chrome.tabs.onRemoved.addListener((tabId) => this.clear(tabId));
  }

  register(node: NodeRef, info: { role?: string; name?: string } = {}): RefEntry {
    let tab = this.#tabs.get(node.tabId);
    if (!tab) this.#tabs.set(node.tabId, (tab = { next: 1, byKey: new Map(), byRef: new Map() }));
    const key = `${node.sessionId ?? ''}:${node.backendNodeId}`;
    const existing = tab.byKey.get(key);
    if (existing) {
      if (info.role) existing.role = info.role;
      if (info.name !== undefined) existing.name = info.name;
      if (node.frameId) existing.frameId = node.frameId;
      return existing;
    }
    const entry: RefEntry = { ...node, ref: `e${tab.next++}`, ...info };
    tab.byKey.set(key, entry);
    tab.byRef.set(entry.ref, entry);
    return entry;
  }

  get(tabId: number, ref: string): RefEntry {
    const entry = this.#tabs.get(tabId)?.byRef.get(ref.trim());
    if (!entry) throw new ToolError(`Unknown ref "${ref}" for tab ${tabId}. Refs reset when the page navigates — take a new page_snapshot (or use find) to get current refs.`);
    return entry;
  }

  all(tabId: number): RefEntry[] {
    return [...(this.#tabs.get(tabId)?.byRef.values() ?? [])];
  }

  clear(tabId: number): void {
    this.#tabs.delete(tabId);
  }
}

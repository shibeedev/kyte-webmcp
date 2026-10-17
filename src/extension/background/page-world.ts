import { ISOLATED_WORLD } from '../../shared/constants.ts';
import type { Cdp } from './cdp.ts';
import { ToolError } from './util.ts';

export interface NodeRef {
  tabId: number;
  sessionId?: string;
  frameId?: string;
  backendNodeId: number;
}

export interface EvalOptions {
  sessionId?: string;
  frameId?: string;
  world?: 'isolated' | 'main';
  userGesture?: boolean;
  awaitPromise?: boolean;
  timeoutMs?: number;
}

/** Object group for handles created during one tool call; released afterwards. */
export const TEMP_GROUP = 'kyte-webmcp-call';

interface ExceptionDetails {
  text: string;
  lineNumber?: number;
  columnNumber?: number;
  url?: string;
  exception?: { description?: string; value?: unknown };
}

export function describeException(details: ExceptionDetails): string {
  const what = details.exception?.description ?? (details.exception?.value !== undefined ? String(details.exception.value) : details.text);
  const where = details.url ? ` (${details.url}:${(details.lineNumber ?? 0) + 1}:${(details.columnNumber ?? 0) + 1})` : '';
  return `${what}${where}`;
}

/**
 * Runs extension functions inside pages. By default they run in a CDP
 * isolated world: they share the DOM with the page but cannot see (or be
 * tampered with by) page JavaScript, and leave no globals behind.
 * Functions passed here must be self-contained (no outer references).
 */
export class PageWorld {
  readonly #cdp: Cdp;
  readonly #contexts = new Map<string, number>();
  readonly #mainFrames = new Map<string, string>();
  readonly #defaultContexts = new Map<string, number>();
  readonly #usedSessions = new Map<number, Set<string>>();

  constructor(cdp: Cdp) {
    this.#cdp = cdp;
    cdp.on((tabId, sessionId, method, params) => {
      const prefix = `${tabId}|${sessionId ?? ''}|`;
      if (method === 'Runtime.executionContextCreated') {
        const aux = params.context.auxData as { frameId?: string; isDefault?: boolean } | undefined;
        if (aux?.isDefault && aux.frameId) this.#defaultContexts.set(`${prefix}${aux.frameId}`, params.context.id);
      } else if (method === 'Runtime.executionContextsCleared') {
        for (const key of this.#contexts.keys()) if (key.startsWith(prefix)) this.#contexts.delete(key);
        for (const key of this.#defaultContexts.keys()) if (key.startsWith(prefix)) this.#defaultContexts.delete(key);
      } else if (method === 'Runtime.executionContextDestroyed') {
        for (const [key, id] of this.#contexts) if (key.startsWith(prefix) && id === params.executionContextId) this.#contexts.delete(key);
        for (const [key, id] of this.#defaultContexts) if (key.startsWith(prefix) && id === params.executionContextId) this.#defaultContexts.delete(key);
      } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
        this.#mainFrames.set(`${tabId}|${sessionId ?? ''}`, params.frame.id);
      }
    });
    const forget = (tabId: number) => {
      for (const key of [...this.#contexts.keys(), ...this.#mainFrames.keys(), ...this.#bindings]) {
        if (key.startsWith(`${tabId}|`)) {
          this.#contexts.delete(key);
          this.#mainFrames.delete(key);
          this.#bindings.delete(key);
        }
      }
    };
    cdp.onDetach(forget);
    chrome.tabs.onRemoved.addListener(forget);
  }

  async mainFrameId(tabId: number, sessionId?: string): Promise<string> {
    const key = `${tabId}|${sessionId ?? ''}`;
    let id = this.#mainFrames.get(key);
    if (!id) {
      const { frameTree } = await this.#cdp.send(tabId, 'Page.getFrameTree', {}, sessionId);
      id = frameTree.frame.id as string;
      this.#mainFrames.set(key, id);
    }
    return id;
  }

  async isolatedContext(tabId: number, sessionId?: string, frameId?: string): Promise<number> {
    const frame = frameId ?? (await this.mainFrameId(tabId, sessionId));
    const key = `${tabId}|${sessionId ?? ''}|${frame}`;
    let id = this.#contexts.get(key);
    if (id === undefined) {
      const res = await this.#cdp.send(tabId, 'Page.createIsolatedWorld', { frameId: frame, worldName: ISOLATED_WORLD, grantUniveralAccess: false }, sessionId);
      id = res.executionContextId as number;
      this.#contexts.set(key, id);
    }
    return id;
  }

  /** The page's own (main world) context of a frame; undefined = the session's main frame default. */
  mainWorldContext(tabId: number, sessionId?: string, frameId?: string): number | undefined {
    if (!frameId) return undefined;
    return this.#defaultContexts.get(`${tabId}|${sessionId ?? ''}|${frameId}`);
  }

  /** Evaluates `fn(...args)` in the page and returns the JSON result. */
  async evaluate<T = unknown>(tabId: number, fn: ((...a: any[]) => unknown) | string, args: unknown[] = [], opts: EvalOptions = {}): Promise<T> {
    const contextId = opts.world === 'main' ? undefined : await this.isolatedContext(tabId, opts.sessionId, opts.frameId);
    const source = typeof fn === 'string' ? fn : fn.toString();
    const expression = `(${source})(...${JSON.stringify(args)})`;
    const run = async (ctx: number | undefined) =>
      this.#cdp.send(
        tabId,
        'Runtime.evaluate',
        { expression, contextId: ctx, returnByValue: true, awaitPromise: opts.awaitPromise ?? true, userGesture: opts.userGesture ?? false, timeout: opts.timeoutMs },
        opts.sessionId,
      );
    let res;
    try {
      res = await run(contextId);
    } catch (error) {
      // The cached world vanished with a navigation: recreate once.
      if (contextId !== undefined && /Cannot find context/i.test(String(error))) {
        this.#forgetContext(tabId, opts.sessionId, contextId);
        res = await run(await this.isolatedContext(tabId, opts.sessionId, opts.frameId));
      } else throw error;
    }
    if (res.exceptionDetails) throw new ToolError(`Page script failed: ${describeException(res.exceptionDetails)}`);
    return res.result.value as T;
  }

  #forgetContext(tabId: number, sessionId: string | undefined, contextId: number): void {
    const prefix = `${tabId}|${sessionId ?? ''}|`;
    for (const [key, id] of this.#contexts) if (key.startsWith(prefix) && id === contextId) this.#contexts.delete(key);
  }

  /** Resolves a DOM node to a remote object id, in the isolated world of its frame (or the main world). */
  async resolve(node: NodeRef, world: 'isolated' | 'main' = 'isolated'): Promise<string> {
    this.#markUsed(node.tabId, node.sessionId);
    const params: Record<string, unknown> = { backendNodeId: node.backendNodeId, objectGroup: TEMP_GROUP };
    if (world === 'isolated') {
      try {
        params.executionContextId = await this.isolatedContext(node.tabId, node.sessionId, node.frameId);
        const { object } = await this.#cdp.send(node.tabId, 'DOM.resolveNode', params, node.sessionId);
        return object.objectId as string;
      } catch {
        // The node may live in a same-process child frame: fall back to its main world.
        delete params.executionContextId;
      }
    }
    try {
      const { object } = await this.#cdp.send(node.tabId, 'DOM.resolveNode', params, node.sessionId);
      return object.objectId as string;
    } catch {
      throw new ToolError('That element no longer exists (the page changed). Take a new page_snapshot and use the new refs.');
    }
  }

  /** Calls `fn` with `this` bound to the element. */
  async callOn<T = unknown>(node: NodeRef, fn: ((this: any, ...a: any[]) => unknown) | string, args: unknown[] = [], opts: Omit<EvalOptions, 'sessionId' | 'frameId'> = {}): Promise<T> {
    const objectId = await this.resolve(node, opts.world ?? 'isolated');
    const res = await this.#cdp.send(
      node.tabId,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: typeof fn === 'string' ? fn : fn.toString(),
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: opts.awaitPromise ?? true,
        userGesture: opts.userGesture ?? false,
      },
      node.sessionId,
    );
    if (res.exceptionDetails) throw new ToolError(`Page script failed: ${describeException(res.exceptionDetails)}`);
    return res.result.value as T;
  }

  /**
   * Evaluates a function that returns an array of DOM elements and returns
   * their backend node ids (and frame ids), so they can become refs.
   */
  async elementsFrom(tabId: number, fn: (...a: any[]) => unknown, args: unknown[], opts: { sessionId?: string; frameId?: string } = {}): Promise<Array<{ backendNodeId: number; frameId?: string }>> {
    this.#markUsed(tabId, opts.sessionId);
    const contextId = await this.isolatedContext(tabId, opts.sessionId, opts.frameId);
    const res = await this.#cdp.send(
      tabId,
      'Runtime.evaluate',
      { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, contextId, returnByValue: false, objectGroup: TEMP_GROUP },
      opts.sessionId,
    );
    if (res.exceptionDetails) throw new ToolError(`Page script failed: ${describeException(res.exceptionDetails)}`);
    if (!res.result.objectId) return [];
    const { result } = await this.#cdp.send(tabId, 'Runtime.getProperties', { objectId: res.result.objectId, ownProperties: true }, opts.sessionId);
    const out: Array<{ backendNodeId: number; frameId?: string }> = [];
    for (const p of result as Array<{ name: string; value?: { objectId?: string; subtype?: string } }>) {
      if (!/^\d+$/.test(p.name) || p.value?.subtype !== 'node' || !p.value.objectId) continue;
      const { node } = await this.#cdp.send(tabId, 'DOM.describeNode', { objectId: p.value.objectId }, opts.sessionId);
      out.push({ backendNodeId: node.backendNodeId, frameId: node.frameId });
    }
    return out;
  }

  readonly #bindings = new Set<string>();

  /**
   * Exposes `globalThis.__kyteEmit(string)` inside the isolated world of a
   * session; calls arrive as Runtime.bindingCalled events (used to stream data
   * such as captured audio out of the page).
   */
  async ensureBinding(tabId: number, sessionId?: string): Promise<void> {
    const key = `${tabId}|${sessionId ?? ''}`;
    if (this.#bindings.has(key)) return;
    await this.#cdp.send(tabId, 'Runtime.addBinding', { name: '__kyteEmit', executionContextName: ISOLATED_WORLD }, sessionId);
    this.#bindings.add(key);
  }

  #markUsed(tabId: number, sessionId?: string): void {
    let set = this.#usedSessions.get(tabId);
    if (!set) this.#usedSessions.set(tabId, (set = new Set()));
    set.add(sessionId ?? '');
  }

  /** Frees remote objects created for a tool call. */
  async releaseTemp(tabId: number): Promise<void> {
    const sessions = this.#usedSessions.get(tabId);
    if (!sessions) return;
    this.#usedSessions.delete(tabId);
    await Promise.all([...sessions].map((s) => this.#cdp.send(tabId, 'Runtime.releaseObjectGroup', { objectGroup: TEMP_GROUP }, s || undefined).catch(() => {})));
  }
}

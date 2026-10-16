import type { ToolContent, ToolResult } from '../../shared/protocol.ts';
import type { ToolSpec } from '../../shared/tool-spec.ts';
import type { Core } from './core.ts';
import type { Session } from './sessions.ts';

export type HandlerOutput = ToolResult | ToolContent[] | string;

export interface CallContext {
  session: Session;
  /** Resolved target tab; -1 for tools declared `noTab`. */
  tabId: number;
  signal: AbortSignal;
  spec: ToolSpec;
  core: Core;
}

export type ToolHandler = (args: any, ctx: CallContext) => Promise<HandlerOutput>;

/** Extension-side half of a feature. Features only talk to the core, never to each other. */
export interface Feature {
  name: string;
  handlers?: Record<string, ToolHandler>;
  /** Called once at startup: subscribe to CDP events, attach hooks, session-end cleanup… */
  setup?(core: Core): void;
}

/** Contributes lines to the "what changed" summary after an input action. */
export type ActionObserver = (tabId: number, since: number) => string[];

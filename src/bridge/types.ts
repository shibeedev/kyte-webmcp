import type { ToolResult } from '../shared/protocol.ts';
import type { ExtensionHub, ServiceHandler } from './hub.ts';
import type { FullCdpClient } from '../features/full-devtools/client.ts';

export interface BridgeContext {
  hub: ExtensionHub;
  outputDir: string;
  version: string;
  fullCdp: FullCdpClient;
}

export type BridgeToolHandler = (args: Record<string, unknown>, ctx: BridgeContext, signal: AbortSignal) => Promise<ToolResult>;

export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
  render(args: Record<string, string>): string;
}

/** Bridge-side half of a feature: tools handled in Node, services the extension can call, prompts. */
export interface BridgeFeature {
  name: string;
  tools?: Record<string, BridgeToolHandler>;
  services?: (ctx: BridgeContext) => Record<string, ServiceHandler>;
  prompts?: PromptDef[];
}

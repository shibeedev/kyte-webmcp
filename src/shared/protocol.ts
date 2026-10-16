/**
 * Wire protocol between the bridge (Node) and the extension: JSON text frames
 * over a loopback WebSocket. One bridge = one MCP client = one session.
 */

export interface ClientInfo {
  name: string;
  version: string;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** A WebMCP tool published by a page, re-exposed by the bridge as an MCP tool. */
export interface PageTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  consequential?: boolean;
  untrustedContent?: boolean;
  origin?: string;
}

export type BridgeToExt =
  | { t: 'welcome'; bridgeVersion: string; pid: number; port: number; client: ClientInfo | null; cliPath: string }
  | { t: 'client'; client: ClientInfo }
  | { t: 'call'; id: number; tool: string; args: Record<string, unknown> }
  | { t: 'cancel'; id: number }
  | { t: 'svc_result'; id: number; ok: true; value: unknown }
  | { t: 'svc_result'; id: number; ok: false; error: string }
  | { t: 'pong' };

export type ExtToBridge =
  | { t: 'hello'; protocol: number; extVersion: string; userAgent: string }
  | { t: 'result'; id: number; result: ToolResult }
  | { t: 'svc'; id: number; name: string; args: Record<string, unknown> }
  | { t: 'page_tools'; tabId: number | null; tools: PageTool[] }
  | { t: 'ping' };

/** Close codes the bridge uses so the extension can react without parsing reasons. */
export const CLOSE_BUSY = 4001;
export const CLOSE_PROTOCOL = 4002;

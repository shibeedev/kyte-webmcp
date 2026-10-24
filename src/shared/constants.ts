/** Values both the bridge (Node) and the extension must agree on. */

/** Bridges listen on the first free port of [PORT_BASE, PORT_BASE + PORT_COUNT). The extension scans the same range. */
export const PORT_BASE = 17831;
export const PORT_COUNT = 10;
export const WS_PATH = '/kyte-webmcp';

/** MCP over HTTP for other machines on the LAN, served while the user allows LAN connections. */
export const LAN_PORT = 17850;
export const LAN_PATH = '/mcp';
/** Chrome native messaging host that runs the LAN endpoint (registered by `kyte-webmcp install`). */
export const NATIVE_HOST = 'com.kyte.webmcp';

/** Derived from the public `key` in the extension manifest, so it is identical on every machine. */
export const EXTENSION_ID = 'pfnhddjiobnpeonenahocokhnhkfhjfc';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

export const PROTOCOL_VERSION = 1;

/** Name of the CDP isolated world the extension runs its page functions in. */
export const ISOLATED_WORLD = 'kyte-webmcp';

/** Prefix of MCP tools that proxy WebMCP tools published by the current page. */
export const PAGE_TOOL_PREFIX = 'site_';

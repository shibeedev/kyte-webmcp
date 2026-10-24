import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pkg from '../../package.json' with { type: 'json' };
import { allToolSpecs } from '../features/specs.ts';
import { bridgeFeatures } from '../features/bridge.ts';
import { FullCdpClient } from '../features/full-devtools/client.ts';
import { runBroker } from '../features/full-devtools/broker.ts';
import { launchAgentChrome } from '../features/full-devtools/launcher.ts';
import { ExtensionHub, type ServiceHandler } from './hub.ts';
import { createMcpServer } from './mcp-server.ts';
import { defaultOutputDir, fileServices } from './files.ts';
import { runLanHost } from './lan.ts';
import { installNativeHost, uninstallNativeHost } from './native-host.ts';
import { log } from './log.ts';
import type { BridgeContext } from './types.ts';

const HELP = `kyte-webmcp ${pkg.version} — MCP server for the Kyte WebMCP Chrome extension

Usage:
  kyte-webmcp [--port <n>] [--output-dir <dir>]
      Run the MCP bridge on stdio. MCP clients (Claude Code, Claude Desktop, Cursor…) start this.
  kyte-webmcp chrome [--chrome-path <exe>] [--profile-dir <dir>] [--url <url>]
      Start Chrome with a dedicated agent profile: full DevTools access without consent prompts.
  kyte-webmcp install
      Let the side panel's "Allow connections from the LAN" switch start the LAN endpoint (registers a Chrome native messaging host for this user).
  kyte-webmcp uninstall
      Remove that registration.
  kyte-webmcp broker
      Internal: the shared full-DevTools connection (started automatically).
  kyte-webmcp lan-host
      Internal: the LAN endpoint, started by Chrome while LAN connections are allowed.
`;

const cliPath = fileURLToPath(import.meta.url);

/** One bridge = one MCP client: the extension hub plus the MCP server. `remote` is the LAN client's address, if any. */
function createBridge(outputDir: string, remote = ''): { ctx: BridgeContext; server: Server } {
  const ctx = { outputDir, version: pkg.version, fullCdp: new FullCdpClient(cliPath), remote } as BridgeContext;
  const services: Record<string, ServiceHandler> = { ...fileServices(outputDir) };
  for (const f of bridgeFeatures) Object.assign(services, f.services?.(ctx));
  ctx.hub = new ExtensionHub(pkg.version, services, cliPath, remote);
  return { ctx, server: createMcpServer(ctx, allToolSpecs, bridgeFeatures) };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'output-dir': { type: 'string' },
      'chrome-path': { type: 'string' },
      'profile-dir': { type: 'string' },
      url: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  const command = positionals[0];
  if (command === 'broker') return runBroker();
  if (command === 'chrome') {
    return launchAgentChrome({
      chromePath: values['chrome-path'],
      profileDir: values['profile-dir'],
      url: values.url,
      extensionDir: path.resolve(path.dirname(cliPath), '..', 'extension'),
    });
  }
  if (command === 'install') {
    const written = installNativeHost(cliPath);
    process.stdout.write(`Registered the Kyte WebMCP LAN host:\n${written.map((w) => `  ${w}`).join('\n')}\nNow turn on "Allow connections from the LAN" in the Kyte WebMCP side panel (reload the extension first if you just updated it).\n`);
    return;
  }
  if (command === 'uninstall') {
    const removed = uninstallNativeHost();
    process.stdout.write(`Removed:\n${removed.map((r) => `  ${r}`).join('\n')}\n`);
    return;
  }
  const outputDir = path.resolve(values['output-dir'] ?? process.env.KYTE_WEBMCP_OUTPUT_DIR ?? defaultOutputDir());
  if (command === 'lan-host') return runLanHost((remote) => createBridge(outputDir, remote));
  if (command) throw new Error(`Unknown command "${command}"\n\n${HELP}`);

  const { ctx, server } = createBridge(outputDir);
  const port = await ctx.hub.listen(values.port ? Number(values.port) : undefined);
  log(`bridge ${pkg.version} listening on 127.0.0.1:${port}; waiting for the Chrome extension`);

  const shutdown = async (reason: string) => {
    log(`shutting down (${reason})`);
    ctx.fullCdp.close();
    await ctx.hub.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on('end', () => void shutdown('stdin closed'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  log(error);
  process.exit(1);
});

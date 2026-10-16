import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { log } from './log.ts';
import type { BridgeContext } from './types.ts';

const HELP = `neo-webmcp ${pkg.version} — MCP server for the Neo WebMCP Chrome extension

Usage:
  neo-webmcp [--port <n>] [--output-dir <dir>]
      Run the MCP bridge on stdio. MCP clients (Claude Code, Claude Desktop, Cursor…) start this.
  neo-webmcp chrome [--chrome-path <exe>] [--profile-dir <dir>] [--url <url>]
      Start Chrome with a dedicated agent profile: full DevTools access without consent prompts.
  neo-webmcp broker
      Internal: the shared full-DevTools connection (started automatically).
`;

const cliPath = fileURLToPath(import.meta.url);

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
  if (command) throw new Error(`Unknown command "${command}"\n\n${HELP}`);

  const outputDir = path.resolve(values['output-dir'] ?? process.env.NEO_WEBMCP_OUTPUT_DIR ?? defaultOutputDir());
  const ctx = { outputDir, version: pkg.version, fullCdp: new FullCdpClient(cliPath) } as BridgeContext;
  const services: Record<string, ServiceHandler> = { ...fileServices(outputDir) };
  for (const f of bridgeFeatures) Object.assign(services, f.services?.(ctx));
  ctx.hub = new ExtensionHub(pkg.version, services, cliPath);
  const port = await ctx.hub.listen(values.port ? Number(values.port) : undefined);
  log(`bridge ${pkg.version} listening on 127.0.0.1:${port}; waiting for the Chrome extension`);

  const server = createMcpServer(ctx, allToolSpecs, bridgeFeatures);
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

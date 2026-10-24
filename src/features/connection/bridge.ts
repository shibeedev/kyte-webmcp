import os from 'node:os';
import type { BridgeFeature } from '../../bridge/types.ts';
import { NOT_CONNECTED_HELP } from '../../bridge/hub.ts';

export const connectionBridge: BridgeFeature = {
  name: 'connection',
  tools: {
    browser_status: async (_args, ctx) => {
      const { hub, fullCdp } = ctx;
      const fdc = fullCdp.status();
      const lines = [
        hub.isConnected() && hub.extension
          ? `Extension: connected (Kyte WebMCP ${hub.extension.version}; ${hub.extension.userAgent})`
          : `Extension: NOT connected. ${NOT_CONNECTED_HELP}`,
        `Bridge: kyte-webmcp ${ctx.version}, port ${hub.port}, pid ${process.pid}`,
        ...(ctx.remote ? [`Connection: over the LAN from ${ctx.remote}; the bridge runs on the browser machine (${os.hostname()}), so file paths refer to that machine`] : []),
        `MCP client: ${hub.client ? `${hub.client.name} ${hub.client.version}` : 'unknown'}`,
        `Full DevTools channel: ${fdc.state}${fdc.source ? ` via ${fdc.source}` : ''}${fdc.error ? ` (${fdc.error})` : ''}${fdc.state === 'idle' ? ' — connects automatically when a tool needs it' : ''}`,
        `Output folder: ${ctx.outputDir}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
};

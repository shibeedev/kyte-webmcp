import { defineTools, obj } from '../../shared/tool-spec.ts';

export const connectionTools = defineTools({
  name: 'browser_status',
  title: 'Browser connection status',
  description:
    'Reports whether the Kyte WebMCP Chrome extension is connected to this bridge, the extension and browser versions, the bridge port, and whether the full DevTools channel is available. Call this first when other tools report that the extension is not connected.',
  inputSchema: obj({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  noTab: true,
});

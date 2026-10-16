import { arr, bool, defineTools, int, obj, oneOf, refParam, str, tabIdParam } from '../../shared/tool-spec.ts';

export const cdpTools = defineTools(
  {
    name: 'cdp_send',
    title: 'Raw DevTools Protocol command',
    description:
      'Sends any Chrome DevTools Protocol command to the tab (or to an iframe via frame ref, or a child session id) and returns the raw result. Domains Chrome does not expose to extensions are routed through the full DevTools channel automatically when it is available. Disabling a domain other tools rely on is ignored to keep them working.',
    inputSchema: obj(
      {
        method: str('Command, e.g. "DOM.getDocument" or "Page.getLayoutMetrics".'),
        params: { type: 'object', description: 'Command parameters.' },
        frame: refParam,
        sessionId: str('Child target session id (see page_info frames).'),
        via: oneOf(['auto', 'extension', 'full'], 'Which channel to use (default auto).'),
        tabId: tabIdParam,
      },
      ['method'],
    ),
    annotations: { readOnlyHint: false, openWorldHint: true },
    timeoutMs: 60_000,
  },
  {
    name: 'cdp_events',
    title: 'Raw DevTools Protocol events',
    description:
      'Subscribes to raw DevTools Protocol events of the tab ("Network.*", "Page.loadEventFired"…) and reads the buffered events. Enable the domain first with cdp_send if it is not already enabled.',
    inputSchema: obj(
      {
        action: oneOf(['subscribe', 'read', 'unsubscribe'], 'What to do.'),
        events: arr(str('Event name or "Domain.*"'), 'Events to subscribe to.'),
        limit: int('Return at most this many of the newest events (default 50).'),
        clear: bool('Clear the buffer after reading (default true).'),
        tabId: tabIdParam,
      },
      ['action'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
);

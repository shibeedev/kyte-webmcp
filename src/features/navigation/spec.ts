import { bool, defineTools, int, obj, oneOf, str, tabIdParam } from '../../shared/tool-spec.ts';

export const navigationTools = defineTools(
  {
    name: 'navigate',
    title: 'Navigate',
    description:
      'Navigates the tab to a URL, or goes back/forward/reloads. Returns the final URL (after redirects), title and HTTP status. Fails with the network error when the page cannot be loaded.',
    inputSchema: obj({
      url: str('URL to load. Omit when using action.'),
      action: oneOf(['back', 'forward', 'reload'], 'History action instead of a URL.'),
      waitUntil: oneOf(['load', 'domcontentloaded', 'networkidle', 'none'], 'When to return (default load).'),
      ignoreCache: bool('For reload: bypass the cache.'),
      timeoutMs: int('Timeout in milliseconds (default 30000).'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    exclusive: true,
    timeoutMs: 35_000,
    maxTimeoutMs: 180_000,
  },
  {
    name: 'wait_for',
    title: 'Wait for condition',
    description:
      'Waits until text appears or disappears, a CSS selector matches a visible element, the network is idle, or a fixed time passes. Always bounded by timeoutMs.',
    inputSchema: obj({
      text: str('Wait until this text is visible on the page.'),
      textGone: str('Wait until this text is no longer visible.'),
      selector: str('Wait until this CSS selector matches a visible element.'),
      networkIdle: bool('Wait until no network request has been in flight for 500 ms.'),
      timeMs: int('Just wait this many milliseconds.'),
      timeoutMs: int('Give up after this many milliseconds (default 10000).'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 15_000,
    maxTimeoutMs: 300_000,
  },
  {
    name: 'page_info',
    title: 'Page info',
    description:
      'Returns URL, title, load state, language, viewport and scroll position, document size, the frame tree (including cross-origin iframes) and the main document\'s security details.',
    inputSchema: obj({ tabId: tabIdParam }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
);

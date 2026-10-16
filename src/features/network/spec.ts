import { arr, bool, defineTools, int, obj, oneOf, savePathParam, str, tabIdParam } from '../../shared/tool-spec.ts';

export const networkTools = defineTools(
  {
    name: 'network_requests',
    title: 'Network requests',
    description:
      'Lists the tab\'s requests like the DevTools Network panel: id, method, URL, status, type, size, duration, cache, initiator. Filter by URL pattern, resource type, method, status or failures. Requests made before the agent started watching the tab are not available — reload to capture them.',
    inputSchema: obj({
      urlPattern: str('Substring or /regex/ the URL must match.'),
      types: arr(oneOf(['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'Ping', 'Preflight', 'Other'], 'Resource type'), 'Only these resource types.'),
      method: str('HTTP method, e.g. "POST".'),
      status: str('Status filter: a code ("404"), a class ("4xx"), or "failed".'),
      limit: int('Return at most this many of the newest matches (default 100).'),
      all: bool('Include requests from before the last main-frame navigation (default false).'),
      clear: bool('Clear the buffer after reading.'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'network_request',
    title: 'Request details',
    description:
      'Full details of one request: request/response headers, request body, response body (text, or saved to a file when binary/large), timing breakdown, security details, initiator stack and WebSocket frames.',
    inputSchema: obj(
      {
        id: str('Request id from network_requests, e.g. "r12".'),
        body: bool('Include the response body (default true).'),
        maxBodyChars: int('Truncate text bodies after this many characters (default 20000).'),
        savePath: savePathParam,
        tabId: tabIdParam,
      },
      ['id'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'network_har',
    title: 'Export HAR',
    description: 'Exports the captured requests of the tab as a HAR 1.2 file (optionally with response bodies) and returns its path.',
    inputSchema: obj({ savePath: savePathParam, bodies: bool('Include response bodies (default false).'), tabId: tabIdParam }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 120_000,
  },
  {
    name: 'network_mock',
    title: 'Intercept network',
    description:
      'Adds, lists or removes interception rules for the tab: block matching requests, answer them with a fake response, or rewrite request headers. Rules are removed when the session ends.',
    inputSchema: obj(
      {
        action: oneOf(['add', 'list', 'remove', 'clear'], 'What to do.'),
        urlPattern: str('Glob pattern for request URLs, "*" matches anything (action add).'),
        resourceType: str('Only this resource type, e.g. "XHR", "Fetch", "Image".'),
        method: str('Only this HTTP method.'),
        respond: {
          ...obj({
            status: int('HTTP status (default 200).'),
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Response headers.' },
            body: str('Response body text.'),
            bodyBase64: str('Binary response body as base64.'),
          }),
          description: 'Answer matching requests with this fake response (action add).',
        },
        block: bool('Fail matching requests (action add).'),
        setHeaders: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers to add or override.' },
        id: str('Rule id (action remove).'),
        tabId: tabIdParam,
      },
      ['action'],
    ),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
);

import { arr, bool, defineTools, int, num, obj, oneOf, str, tabIdParam } from '../../shared/tool-spec.ts';

export const consoleTools = defineTools({
  name: 'console_logs',
  title: 'Console logs',
  description:
    'Reads the tab\'s console like the DevTools Console panel: console.* calls, uncaught exceptions and promise rejections (with stack traces), and browser-side messages (network errors, violations, deprecations) — from the page and its iframes/workers. Messages logged before the agent started watching are included as far as Chrome kept them.',
  inputSchema: obj({
    levels: arr(oneOf(['log', 'info', 'warning', 'error', 'debug'], 'Level'), 'Only these levels (default all).'),
    pattern: str('Only messages matching this regular expression (case-insensitive).'),
    since: num('Only messages after this time (ms since epoch).'),
    limit: int('Return at most this many of the newest matching messages (default 100).'),
    stack: bool('Include stack traces (default: only for errors).'),
    clear: bool('Clear the buffer after reading.'),
    tabId: tabIdParam,
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
});

import { arr, bool, defineTools, int, obj, str } from '../../shared/tool-spec.ts';

export const tabsTools = defineTools(
  {
    name: 'tabs_list',
    title: 'List tabs',
    description:
      'Lists every open tab in every window with its id, title, URL, whether it is active/audible, its tab group, and which tab is this session\'s target. Use the ids with tab_select or the tabId parameter of other tools.',
    inputSchema: obj({ currentWindowOnly: bool('Only list tabs of the last focused window.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    noTab: true,
  },
  {
    name: 'tab_open',
    title: 'Open tab',
    description:
      'Opens a URL in a new tab, puts it in this session\'s tab group and makes it the session target tab. Console and network recording start before the page loads, so the load itself is captured. Waits for the page to load unless waitUntil is "none"; a failed load is reported as an error.',
    inputSchema: obj(
      {
        url: str('URL to open.'),
        background: bool('Open without activating the tab (default false).'),
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'none'], description: 'When to return (default load).' },
        timeoutMs: int('Load timeout in milliseconds (default 30000).'),
      },
      ['url'],
    ),
    annotations: { readOnlyHint: false, openWorldHint: true },
    noTab: true,
    timeoutMs: 35_000,
    maxTimeoutMs: 180_000,
  },
  {
    name: 'tab_select',
    title: 'Select target tab',
    description: 'Makes a tab the default target for subsequent tools in this session, and optionally brings it to the front.',
    inputSchema: obj({ tabId: int('Tab id from tabs_list.'), activate: bool('Also activate the tab and focus its window (default false).') }, ['tabId']),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    noTab: true,
  },
  {
    name: 'tab_close',
    title: 'Close tabs',
    description: 'Closes one or more tabs by id (from tabs_list). Closing the session target tab makes the session follow the user\'s active tab again.',
    inputSchema: obj({ tabIds: arr(int('Tab id'), 'Tabs to close.', { minItems: 1 }) }, ['tabIds']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    noTab: true,
  },
);

import { bool, defineTools, int, num, obj, oneOf, savePathParam, str, tabIdParam } from '../../shared/tool-spec.ts';

export const browserTools = defineTools(
  {
    name: 'downloads',
    title: 'Downloads',
    description:
      'Manages browser downloads: "download" starts downloading a URL, "list" shows recent downloads, "wait" waits for a download to finish, "cancel" cancels one.',
    inputSchema: obj(
      {
        action: oneOf(['download', 'list', 'wait', 'cancel'], 'What to do.'),
        url: str('URL to download (action download).'),
        filename: str('File name relative to the Downloads folder (action download).'),
        id: int('Download id (actions wait/cancel).'),
        limit: int('How many downloads to list (default 20).'),
        timeoutMs: int('Timeout for wait (default 60000).'),
      },
      ['action'],
    ),
    annotations: { readOnlyHint: false, openWorldHint: true },
    noTab: true,
    timeoutMs: 65_000,
    maxTimeoutMs: 900_000,
  },
  {
    name: 'history_search',
    title: 'Search history',
    description: 'Searches the browsing history by text and time range.',
    inputSchema: obj({
      text: str('Text to match in URL or title (empty matches all).'),
      startTime: num('Only visits after this time (ms since epoch).'),
      maxResults: int('Maximum results (default 50).'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    noTab: true,
  },
  {
    name: 'bookmarks',
    title: 'Bookmarks',
    description: 'Searches the user\'s bookmarks by title/URL, creates a bookmark (or folder), or removes one by id.',
    inputSchema: obj(
      {
        action: oneOf(['search', 'create', 'remove'], 'What to do.'),
        query: str('Search text (action search).'),
        title: str('Bookmark title (action create).'),
        url: str('Bookmark URL (action create).'),
        parentId: str('Folder id to create in (default: Other bookmarks).'),
        id: str('Bookmark id (action remove).'),
      },
      ['action'],
    ),
    annotations: { readOnlyHint: false, openWorldHint: false },
    noTab: true,
  },
  {
    name: 'clipboard',
    title: 'Clipboard',
    description: 'Reads or writes the system clipboard as plain text.',
    inputSchema: obj({ action: oneOf(['read', 'write'], 'What to do.'), text: str('Text to write (action write).') }, ['action']),
    annotations: { readOnlyHint: false, openWorldHint: false },
    noTab: true,
  },
  {
    name: 'pdf_save',
    title: 'Save page as PDF',
    description: 'Prints the page to a PDF file and returns its path.',
    inputSchema: obj({
      savePath: savePathParam,
      landscape: bool('Landscape orientation (default false).'),
      printBackground: bool('Print background graphics (default true).'),
      scale: num('Scale factor 0.1-2 (default 1).', { minimum: 0.1, maximum: 2 }),
      paper: oneOf(['A4', 'Letter', 'Legal', 'A3', 'A5'], 'Paper size (default A4).'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 60_000,
  },
);

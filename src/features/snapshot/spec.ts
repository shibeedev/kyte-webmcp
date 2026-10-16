import { bool, defineTools, int, obj, refParam, str, tabIdParam } from '../../shared/tool-spec.ts';

export const snapshotTools = defineTools(
  {
    name: 'page_snapshot',
    title: 'Accessibility snapshot',
    description:
      'Returns the page as a compact accessibility tree (roles, names, states, values) built by Chrome itself, including cross-origin iframes and shadow DOM. Every interactive element gets a stable ref like [ref=e12] to use with click, type, fill_form, screenshot, dom_inspect and other tools. Prefer this over screenshots for understanding structure.',
    inputSchema: obj({
      interactiveOnly: bool('Only list interactive elements (buttons, links, inputs…), flattened.'),
      viewportOnly: bool('Only include elements currently inside the viewport.'),
      root: refParam,
      maxChars: int('Truncate the output after this many characters (default 30000).'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    timeoutMs: 30_000,
  },
  {
    name: 'page_read',
    title: 'Read page as Markdown',
    description:
      'Returns the readable content of the page (or of one element) as Markdown: headings, paragraphs, lists, links, tables, code. Long content is paginated with offset/maxChars.',
    inputSchema: obj({
      ref: refParam,
      selector: str('CSS selector of the element to read instead of the whole page.'),
      mainOnly: bool('Prefer the <main>/<article> region when present (default true).'),
      includeImages: bool('Include images as ![alt](src) (default false).'),
      offset: int('Character offset to start from (for pagination).'),
      maxChars: int('Maximum characters to return (default 20000).'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'find',
    title: 'Find elements',
    description:
      'Finds elements by visible text, CSS selector, XPath, or accessible role/name (searches iframes and shadow DOM) and returns refs with role, name and position.',
    inputSchema: obj({
      text: str('Text to search for (case-insensitive substring).'),
      selector: str('CSS selector.'),
      xpath: str('XPath expression.'),
      role: str('Accessible role, e.g. "button", "link", "textbox".'),
      name: str('Accessible name to match together with role.'),
      limit: int('Maximum results (default 20).'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
);

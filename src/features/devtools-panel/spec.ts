import { bool, defineTools, int, obj, refParam, str, tabIdParam } from '../../shared/tool-spec.ts';

export const devtoolsPanelTools = defineTools(
  {
    name: 'devtools_context',
    title: 'What the user selected in DevTools',
    description:
      'When the user has DevTools open on the tab: returns the element currently selected in the Elements panel (selector, HTML, ref) and the items the user sent to the agent from the "Neo MCP" DevTools panel (elements or network requests with notes).',
    inputSchema: obj({ clearInbox: bool('Remove the returned inbox items.'), tabId: tabIdParam }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'devtools_reveal',
    title: 'Show in DevTools',
    description:
      'Shows something to the user in their open DevTools: an element in the Elements panel (ref or selector), or a source file at a line in the Sources panel (url + line). Requires DevTools to be open on the tab.',
    inputSchema: obj({
      ref: refParam,
      selector: str('CSS selector of the element.'),
      url: str('Source file URL to open in the Sources panel.'),
      line: int('1-based line number.'),
      column: int('1-based column number.'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
);

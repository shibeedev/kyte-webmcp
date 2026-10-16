import { arr, bool, defineTools, obj, oneOf, refParam, str, tabIdParam } from '../../shared/tool-spec.ts';

export const elementsTools = defineTools({
  name: 'dom_inspect',
  title: 'Inspect element',
  description:
    'Inspects one element like the DevTools Elements panel: outer HTML, attributes, box model, computed styles, matched CSS rules with their stylesheet and line, inherited styles, event listeners, and accessibility properties.',
  inputSchema: obj({
    ref: refParam,
    selector: str('CSS selector (first match) instead of a ref.'),
    include: arr(oneOf(['html', 'attributes', 'box', 'computed', 'rules', 'listeners', 'accessibility'], 'Section'), 'Sections to include (default all except full computed).'),
    allComputed: bool('Return every computed property instead of the common ones.'),
    tabId: tabIdParam,
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
});

import { arr, bool, defineTools, int, num, obj, oneOf, refParam, str, tabIdParam } from '../../shared/tool-spec.ts';

const modifiers = arr(oneOf(['Alt', 'Control', 'Meta', 'Shift'], 'Modifier key'), 'Modifier keys held during the action.');
const point = obj({ x: num('X in CSS pixels from the viewport left.'), y: num('Y in CSS pixels from the viewport top.') }, ['x', 'y']);

export const inputTools = defineTools(
  {
    name: 'click',
    title: 'Click',
    description:
      'Clicks an element (by ref) or a viewport point with real, trusted mouse events. Scrolls the element into view first and warns if another element covers it. Returns what changed: navigation, new tabs, open dialogs, new console errors.',
    inputSchema: obj({
      ref: refParam,
      x: num('Viewport X (use with y instead of ref).'),
      y: num('Viewport Y.'),
      button: oneOf(['left', 'right', 'middle'], 'Mouse button (default left).'),
      clickCount: int('2 for double-click (default 1).', { minimum: 1, maximum: 3 }),
      modifiers,
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    exclusive: true,
  },
  {
    name: 'hover',
    title: 'Hover',
    description: 'Moves the mouse over an element (by ref) or a viewport point, triggering hover menus and tooltips.',
    inputSchema: obj({ ref: refParam, x: num('Viewport X.'), y: num('Viewport Y.'), tabId: tabIdParam }),
    annotations: { readOnlyHint: false, openWorldHint: false },
    exclusive: true,
  },
  {
    name: 'type',
    title: 'Type text',
    description:
      'Types text into an element (by ref) or into the focused element like a person: one trusted key event per character (characters without a US key are committed as an IME would). Text longer than 200 characters is inserted in one go like a paste, unless slowly=true. Line breaks are inserted as text; use submit=true or press_key to press Enter. Can clear the existing value first.',
    inputSchema: obj(
      {
        ref: refParam,
        text: str('Text to type.'),
        clear: bool('Select and delete the current value first (default false).'),
        submit: bool('Press Enter after typing (default false).'),
        slowly: bool('Pause briefly after each key, and type key by key even when the text is long (default false).'),
        tabId: tabIdParam,
      },
      ['text'],
    ),
    annotations: { readOnlyHint: false, openWorldHint: true },
    exclusive: true,
  },
  {
    name: 'press_key',
    title: 'Press keys',
    description: 'Presses a key or key combination on the focused element, e.g. "Enter", "Escape", "Control+A", "Shift+Tab", "ArrowDown".',
    inputSchema: obj({ keys: str('Key or combination joined with "+".'), repeat: int('Press this many times (default 1).', { minimum: 1, maximum: 50 }), tabId: tabIdParam }, ['keys']),
    annotations: { readOnlyHint: false, openWorldHint: true },
    exclusive: true,
  },
  {
    name: 'fill_form',
    title: 'Fill form',
    description:
      'Fills several form fields in one call. Text inputs and textareas receive the value, checkboxes/radios/switches take "true"/"false", selects take an option label or value.',
    inputSchema: obj(
      {
        fields: arr(obj({ ref: refParam, value: str('Value to set.') }, ['ref', 'value']), 'Fields to fill, in order.', { minItems: 1 }),
        tabId: tabIdParam,
      },
      ['fields'],
    ),
    annotations: { readOnlyHint: false, openWorldHint: true },
    exclusive: true,
  },
  {
    name: 'select_option',
    title: 'Select option',
    description: 'Selects one or more options of a <select> element by visible label or value.',
    inputSchema: obj({ ref: refParam, values: arr(str('Option label or value'), 'Options to select.', { minItems: 1 }), tabId: tabIdParam }, ['ref', 'values']),
    annotations: { readOnlyHint: false, openWorldHint: true },
    exclusive: true,
  },
  {
    name: 'scroll',
    title: 'Scroll',
    description:
      'Scrolls an element into view (ref), or scrolls the page or the element under a point by a direction/amount using real mouse-wheel events (with script in a background tab, where Chrome ignores wheel events).',
    inputSchema: obj({
      ref: refParam,
      direction: oneOf(['up', 'down', 'left', 'right'], 'Scroll direction.'),
      amount: num('Pixels to scroll (default: 80% of the viewport).'),
      x: num('Viewport X of the element to scroll (default: viewport center).'),
      y: num('Viewport Y.'),
      toEdge: oneOf(['top', 'bottom'], 'Scroll the page to its very top or bottom.'),
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: false, openWorldHint: false },
    exclusive: true,
  },
  {
    name: 'drag',
    title: 'Drag and drop',
    description: 'Drags from one element or point to another with real mouse events; supports both mouse-driven and HTML5 drag-and-drop.',
    inputSchema: obj({
      fromRef: refParam,
      toRef: refParam,
      from: { ...point, description: 'Start point in viewport CSS pixels (instead of fromRef).' },
      to: { ...point, description: 'End point in viewport CSS pixels (instead of toRef).' },
      tabId: tabIdParam,
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    exclusive: true,
  },
  {
    name: 'upload_file',
    title: 'Upload files',
    description: 'Attaches local files (absolute paths on this machine) to a file input element.',
    inputSchema: obj({ ref: refParam, paths: arr(str('Absolute file path'), 'Files to attach.', { minItems: 1 }), tabId: tabIdParam }, ['ref', 'paths']),
    annotations: { readOnlyHint: false, openWorldHint: true },
    exclusive: true,
  },
  {
    name: 'dialog',
    title: 'Handle dialog',
    description: 'Accepts or dismisses the JavaScript dialog (alert, confirm, prompt, beforeunload) currently open in the tab.',
    inputSchema: obj({ action: oneOf(['accept', 'dismiss'], 'What to do.'), promptText: str('Text to enter into a prompt() before accepting.'), tabId: tabIdParam }, ['action']),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
);

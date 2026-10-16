import { arr, bool, defineTools, int, obj, oneOf, refParam, str, tabIdParam } from '../../shared/tool-spec.ts';

export const scriptTools = defineTools({
  name: 'evaluate',
  title: 'Run JavaScript',
  description:
    'Runs JavaScript in the page and returns the result as JSON. Pass either an expression ("document.title") or a function ("(a, b) => a + b") with args. Promises are awaited. DOM nodes, functions and cyclic objects are described instead of failing. world="isolated" runs in a private world that cannot see page globals; frame selects an iframe by the ref of its <iframe> element.',
  inputSchema: obj({
    expression: str('JavaScript expression to evaluate.'),
    function: str('JavaScript function source, called with args.'),
    args: arr({ description: 'JSON-serializable argument' }, 'Arguments for function.'),
    world: oneOf(['main', 'isolated'], 'Execution world (default main, i.e. the page\'s own JavaScript context).'),
    frame: refParam,
    userGesture: bool('Treat the call as a user gesture (allows play(), fullscreen, clipboard).'),
    timeoutMs: int('Timeout in milliseconds (default 30000).'),
    tabId: tabIdParam,
  }),
  annotations: { readOnlyHint: false, openWorldHint: true },
  timeoutMs: 35_000,
  maxTimeoutMs: 300_000,
});

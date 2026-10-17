/**
 * DevTools page: runs whenever the user opens DevTools on a tab. It creates
 * the "Kyte WebMCP" panel, mirrors the Elements-panel selection to the agent and
 * performs reveal requests (element in Elements, file:line in Sources).
 */
export {};

const tabId = chrome.devtools.inspectedWindow.tabId;
const port = chrome.runtime.connect({ name: `devtools-page:${tabId}` });

chrome.devtools.panels.create('Kyte WebMCP', 'icons/icon32.png', 'panel.html');

/** Evaluated in the inspected page: describes $0 with a unique CSS path. */
const DESCRIBE_SELECTION = `(() => {
  const el = $0;
  if (!el || el.nodeType !== 1) return null;
  const path = [];
  let n = el;
  while (n && n.nodeType === 1 && n !== document.documentElement) {
    if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { path.unshift('#' + CSS.escape(n.id)); break; }
    const tag = n.tagName.toLowerCase();
    const parent = n.parentElement;
    if (!parent) { path.unshift(tag); break; }
    const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
    path.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : tag);
    n = parent;
  }
  return {
    selector: path.join(' > ') || 'html',
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: Array.from(el.classList).slice(0, 4),
    text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
    html: el.outerHTML.slice(0, 2000),
  };
})()`;

function sendSelection(): void {
  chrome.devtools.inspectedWindow.eval(DESCRIBE_SELECTION, (result, error) => {
    port.postMessage({ type: 'selection', selection: error ? null : result });
  });
}

chrome.devtools.panels.elements.onSelectionChanged.addListener(sendSelection);
sendSelection();

port.onMessage.addListener((msg: { type: string; id: number; selector?: string; url?: string; line?: number; column?: number }) => {
  if (msg.type !== 'reveal') return;
  if (msg.url) {
    chrome.devtools.panels.openResource(msg.url, Math.max(0, (msg.line ?? 1) - 1), Math.max(0, (msg.column ?? 1) - 1), () => {
      port.postMessage({ type: 'revealed', id: msg.id, ok: true });
    });
    return;
  }
  const expression = `(() => { const el = document.querySelector(${JSON.stringify(msg.selector)}); if (!el) return false; inspect(el); return true; })()`;
  chrome.devtools.inspectedWindow.eval(expression, (result, error) => {
    const found = (result as unknown) === true;
    port.postMessage({ type: 'revealed', id: msg.id, ok: !error && found, error: error ? (error.isException ? String(error.value) : error.description) : found ? undefined : 'element not found' });
  });
});

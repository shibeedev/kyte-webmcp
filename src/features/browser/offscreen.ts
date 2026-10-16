/** Offscreen-document half of the browser feature: clipboard access (needs a document). */
type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

function area(): HTMLTextAreaElement {
  let el = document.getElementById('clipboard') as HTMLTextAreaElement | null;
  if (!el) {
    el = document.createElement('textarea');
    el.id = 'clipboard';
    document.body.appendChild(el);
  }
  return el;
}

export const browserOffscreenHandlers: Record<string, Handler> = {
  async 'clipboard.read'() {
    const el = area();
    el.value = '';
    el.focus();
    document.execCommand('paste');
    return el.value;
  },
  async 'clipboard.write'(p) {
    const el = area();
    el.value = String(p.text ?? '');
    el.select();
    if (!document.execCommand('copy')) throw new Error('the copy command failed');
    return true;
  },
};

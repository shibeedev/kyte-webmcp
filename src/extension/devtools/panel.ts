/**
 * The "Kyte WebMCP" DevTools panel: share the selected element or a network
 * request with the agent (with a note), and watch what the agent does on
 * this tab. All page/agent data is rendered with textContent.
 */
import { localize, t } from '../i18n.ts';
import type { ActivityEntry } from '../background/activity.ts';
import type { DevtoolsSelection, InboxItem } from '../background/ui-hub.ts';

const tabId = chrome.devtools.inspectedWindow.tabId;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let port: chrome.runtime.Port | null = null;
let selection: DevtoolsSelection | null = null;
let activity: ActivityEntry[] = [];
const requests: Array<{ entry: chrome.devtools.network.Request; at: number }> = [];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...children: Array<Node | string | null>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const c of children) if (c !== null) el.append(c);
  return el;
}

function renderSelection(): void {
  const box = $('selection');
  if (!selection) {
    box.replaceChildren();
    $('no-selection').hidden = false;
    $<HTMLButtonElement>('send-element').disabled = true;
    return;
  }
  $('no-selection').hidden = true;
  $<HTMLButtonElement>('send-element').disabled = false;
  const tag = `<${selection.tag}${selection.id ? `#${selection.id}` : ''}${selection.classes?.length ? `.${selection.classes.join('.')}` : ''}>`;
  box.replaceChildren(h('div', 'tag', tag), h('div', '', selection.selector));
  if (selection.text) box.append(h('div', 'text', `"${selection.text.slice(0, 160)}"`));
}

function renderInbox(items: InboxItem[]): void {
  $('inbox').replaceChildren(
    ...items.map((item) => {
      const data = item.data as Record<string, string>;
      const label = item.kind === 'element' ? `element ${data.selector}` : `${data.method} ${data.status} ${data.url}`;
      const remove = h('button', 'btn', t('dtRemove'));
      remove.addEventListener('click', () => port?.postMessage({ type: 'removeInbox', id: item.id }));
      return h('li', '', h('span', 'grow', `#${item.id} ${label}${item.note ? ` — "${item.note}"` : ''}`), remove);
    }),
  );
  $('no-inbox').hidden = items.length > 0;
}

function renderActivity(): void {
  const shown = [...activity].reverse().slice(0, 50);
  $('activity').replaceChildren(
    ...shown.map((e) => h('li', '', h('span', '', new Date(e.startedAt).toLocaleTimeString([], { hour12: false })), h('span', e.status === 'error' ? 'err' : 'ok', e.status === 'running' ? '…' : e.status === 'ok' ? '✓' : '✗'), h('span', 'grow', `${e.tool} ${e.args}${e.summary ? ` → ${e.summary}` : ''}`))),
  );
  $('no-activity').hidden = shown.length > 0;
}

function renderRequests(): void {
  const rows = requests.slice(-60).reverse();
  $('requests').replaceChildren(
    ...rows.map(({ entry }) => {
      const send = h('button', 'btn', t('dtSend'));
      send.addEventListener('click', () => {
        entry.getContent((content) => {
          port?.postMessage({
            type: 'send',
            kind: 'request',
            note: $<HTMLInputElement>('note').value.trim(),
            data: { method: entry.request.method, url: entry.request.url, status: entry.response.status, mimeType: entry.response.content.mimeType, response: (content ?? '').slice(0, 4000) },
          });
          send.textContent = t('dtSent');
        });
      });
      const status = entry.response.status;
      return h(
        'tr',
        '',
        h('td', status >= 400 || status === 0 ? 'err' : 'ok', String(status || 'ERR')),
        h('td', '', entry.request.method),
        h('td', 'url', entry.request.url),
        h('td', '', entry.response.content.mimeType ?? ''),
        h('td', '', send),
      );
    }),
  );
  $('no-requests').hidden = rows.length > 0;
}

function connect(): void {
  port = chrome.runtime.connect({ name: `devtools-panel:${tabId}` });
  port.onMessage.addListener((msg: { type: string } & Record<string, any>) => {
    if (msg.type === 'status') {
      const agent = $('agent');
      agent.className = `agent${msg.sessions.length ? ' on' : ''}`;
      $('agent-text').textContent = msg.sessions.length ? `${t('dtAgentOn')} (${msg.sessions.map((s: { name: string }) => s.name).join(', ')})` : t('dtAgentOff');
      selection = msg.selection;
      activity = msg.activity;
      renderSelection();
      renderInbox(msg.inbox);
      renderActivity();
    } else if (msg.type === 'selection') {
      selection = msg.selection;
      renderSelection();
    } else if (msg.type === 'activity') {
      const i = activity.findIndex((e) => e.id === msg.entry.id);
      if (i >= 0) activity[i] = msg.entry;
      else activity.push(msg.entry);
      renderActivity();
    }
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 500));
}

localize();
$('send-element').addEventListener('click', () => {
  if (!selection) return;
  port?.postMessage({ type: 'send', kind: 'element', note: $<HTMLInputElement>('note').value.trim(), data: { selector: selection.selector, tag: selection.tag, text: selection.text, html: selection.html } });
  $<HTMLInputElement>('note').value = '';
});
chrome.devtools.network.onRequestFinished.addListener((entry) => {
  requests.push({ entry: entry as chrome.devtools.network.Request, at: Date.now() });
  if (requests.length > 200) requests.shift();
  renderRequests();
});
renderRequests();
connect();

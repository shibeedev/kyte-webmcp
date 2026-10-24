/**
 * Side panel: connection status, sessions with Stop/Resume, live activity,
 * WebMCP tools of the active tab, settings and setup instructions.
 * Everything coming from agents or pages is rendered with textContent.
 */
import { localize, t } from '../i18n.ts';
import { LAN_PATH } from '../../shared/constants.ts';
import type { ActivityEntry } from '../background/activity.ts';
import type { SessionView } from '../background/core.ts';
import type { LanView } from '../background/lan.ts';
import type { SettingsData } from '../background/settings.ts';

interface WebmcpTool {
  name: string;
  description: string;
  readOnly: boolean;
  consequential: boolean;
}

interface State {
  extVersion: string;
  extensionId: string;
  ports: [number, number];
  sessions: SessionView[];
  activity: ActivityEntry[];
  settings: SettingsData;
  lan: LanView;
  data: { webmcp?: Record<string, WebmcpTool[]> };
}

const GROUP_COLORS: Record<string, string> = { grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038', pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e' };

let state: State | null = null;
let activeTabId: number | null = null;
let cliPath = '';
let filter = '';
/** The address of this computer the LAN commands use (several when it has more than one network adapter). */
let lanAddress = '';
const openEntries = new Set<number>();
let port: chrome.runtime.Port | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function send(msg: Record<string, unknown>): void {
  port?.postMessage(msg);
}

function connect(): void {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener((msg: { type: string } & Record<string, any>) => {
    if (msg.type === 'state') {
      state = msg as unknown as State;
      renderAll();
    } else if (msg.type === 'activity' && state) {
      const entry = msg.entry as ActivityEntry;
      const i = state.activity.findIndex((e) => e.id === entry.id);
      if (i >= 0) state.activity[i] = entry;
      else {
        state.activity.push(entry);
        if (state.activity.length > 300) state.activity.shift();
      }
      renderActivity();
    } else if (msg.type === 'data' && state) {
      (state.data as Record<string, unknown>)[msg.key] = msg.value;
      renderWebmcp();
    }
  });
  // The service worker may restart; reconnect so the panel never shows stale data.
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 500);
  });
}

function renderStatus(): void {
  if (!state) return;
  const status = $('status');
  const sessions = state.sessions;
  const paused = sessions.some((s) => s.paused);
  status.className = `status ${sessions.length ? (paused ? 'paused' : 'connected') : 'waiting'}`;
  $('status-text').textContent = sessions.length ? t('statusConnected', String(sessions.length)) : t('statusWaiting');
  const stopAll = $<HTMLButtonElement>('stop-all');
  stopAll.hidden = !sessions.length;
  const allPaused = sessions.length > 0 && sessions.every((s) => s.paused);
  stopAll.textContent = allPaused ? t('resumeAll') : t('stopAll');
  stopAll.className = `btn ${allPaused ? 'resume' : 'danger'}`;
  stopAll.onclick = () => send({ type: allPaused ? 'resumeAll' : 'stopAll' });
}

function renderSessions(): void {
  if (!state) return;
  const list = $('sessions');
  list.replaceChildren(
    ...state.sessions.map((s) => {
      const title = s.targetTabId !== null ? tabTitles.get(s.targetTabId) : undefined;
      if (s.targetTabId !== null && title === undefined) void loadTitle(s.targetTabId);
      const target = s.targetTabId === null ? t('targetFollows') : title ? `"${title.length > 40 ? `${title.slice(0, 39)}…` : title}"` : t('targetTab', String(s.targetTabId));
      const badge = s.paused ? h('span', { class: 'badge paused' }, t('statePaused')) : s.busy ? h('span', { class: 'badge busy' }, t('stateBusy')) : h('span', { class: 'badge' }, t('stateIdle'));
      const lan = s.remote ? h('span', { class: 'badge lan' }, 'LAN') : null;
      const button = h('button', { class: `btn small ${s.paused ? 'resume' : 'danger'}`, type: 'button' }, s.paused ? t('resume') : t('stop'));
      button.addEventListener('click', () => send({ type: s.paused ? 'resume' : 'pause', sessionId: s.id }));
      const chip = h('span', { class: 'chip' });
      chip.style.background = GROUP_COLORS[s.color] ?? 'var(--accent)';
      return h(
        'li',
        { class: 'session', 'data-session': s.id },
        chip,
        h('div', {}, h('div', { class: 'name' }, s.name, s.clientVersion ? h('span', { class: 'ver' }, s.clientVersion) : null), h('div', { class: 'meta' }, h('span', {}, `${t('targetLabel')}: ${target}`), h('span', {}, `${t('callsLabel')}: ${s.callCount}`), badge, lan)),
        button,
      );
    }),
  );
  $('no-sessions').hidden = state.sessions.length > 0;
  // Setup help is most useful while nothing is connected.
  const setup = $<HTMLDetailsElement>('setup');
  if (!state.sessions.length && !setup.dataset.touched) setup.open = true;
}

const tabTitles = new Map<number, string>();

/** Shows the target tab by its title instead of its numeric id. */
async function loadTitle(tabId: number): Promise<void> {
  tabTitles.set(tabId, '');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  tabTitles.set(tabId, tab?.title || tab?.url || '');
  renderSessions();
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.title && tabTitles.has(tabId)) {
    tabTitles.set(tabId, info.title);
    renderSessions();
  }
});

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

function renderActivity(): void {
  if (!state) return;
  const q = filter.trim().toLowerCase();
  const entries = [...state.activity].reverse().filter((e) => !q || `${e.tool} ${e.args} ${e.summary ?? ''} ${e.client}`.toLowerCase().includes(q)).slice(0, 200);
  $('activity').replaceChildren(
    ...entries.map((e) => {
      const note = e.tool === '·';
      const stateText = e.status === 'running' ? '…' : `${e.status === 'ok' ? '✓' : '✗'} ${e.durationMs !== undefined && !note ? `${e.durationMs} ms` : ''}`;
      const li = h(
        'li',
        { class: `entry ${note ? 'note' : e.status}${openEntries.has(e.id) ? ' open' : ''}`, 'data-id': String(e.id) },
        h('div', { class: 'line1' }, h('time', {}, fmtTime(e.startedAt)), h('span', { class: 'tool' }, note ? e.summary ?? '' : e.tool), !note ? h('span', { class: 'who' }, `${e.client}${e.tabId !== null ? ` · tab ${e.tabId}` : ''}`) : null, !note ? h('span', { class: 'state' }, stateText) : null),
        !note && e.args ? h('div', { class: 'args' }, e.args) : null,
        !note && e.summary ? h('div', { class: 'summary' }, e.summary) : null,
      );
      li.addEventListener('click', () => {
        if (openEntries.has(e.id)) openEntries.delete(e.id);
        else openEntries.add(e.id);
        li.classList.toggle('open');
      });
      return li;
    }),
  );
  $('no-activity').hidden = state.activity.length > 0;
}

function renderWebmcp(): void {
  if (!state) return;
  const tools = activeTabId !== null ? (state.data.webmcp?.[String(activeTabId)] ?? []) : [];
  $('webmcp').replaceChildren(
    ...tools.map((tool) =>
      h(
        'li',
        {},
        h('div', {}, h('span', { class: 'tname' }, tool.name), tool.readOnly ? h('span', { class: 'tag ro' }, 'read-only') : null, tool.consequential ? h('span', { class: 'tag cq' }, 'consequential') : null),
        h('div', { class: 'desc' }, tool.description),
      ),
    ),
  );
  $('no-webmcp').hidden = tools.length > 0;
}

function renderSettings(): void {
  if (!state) return;
  $<HTMLInputElement>('set-overlay').checked = state.settings.overlay;
  $<HTMLSelectElement>('set-whisper').value = state.settings.whisperModel;
}

function renderLan(): void {
  if (!state) return;
  const { lan } = state;
  $<HTMLInputElement>('set-lan').checked = state.settings.lan;
  const sub = $('lan-state');
  sub.className = `sub ${lan.state}`;
  sub.textContent =
    lan.state === 'on' ? t('lanOn', String(lan.port)) : lan.state === 'starting' ? t('lanStarting') : lan.state === 'error' ? (lan.notInstalled ? t('lanNotInstalledShort') : lan.error) : t('lanOff');
  $('lan-install').hidden = !(state.settings.lan && lan.notInstalled);
  $('cmd-lan-install').textContent = `node "${cliPath || '<path-to-kyte-webmcp>/dist/bridge/cli.mjs'}" install`;
  $('lan-ready').hidden = !(state.settings.lan && lan.state === 'on');
  if (lan.state !== 'on') return;
  if (!lan.addresses.includes(lanAddress)) lanAddress = lan.addresses[0] ?? '';
  const select = $<HTMLSelectElement>('lan-address');
  select.replaceChildren(...lan.addresses.map((a) => h('option', { value: a }, a)));
  select.value = lanAddress;
  const url = `http://${lanAddress || t('lanNoAddress')}:${lan.port}${LAN_PATH}`;
  $('cmd-lan-claude').textContent = `claude mcp add --transport http kyte-webmcp-lan ${url} --header "Authorization: Bearer ${lan.token}"`;
  $('cmd-lan-json').textContent = JSON.stringify({ mcpServers: { 'kyte-webmcp-lan': { type: 'http', url, headers: { Authorization: `Bearer ${lan.token}` } } } }, null, 2);
}

function renderSetup(): void {
  if (!state) return;
  const path = cliPath || '<path-to-kyte-webmcp>/dist/bridge/cli.mjs';
  $('cmd-claude').textContent = `claude mcp add kyte-webmcp -- node "${path}"`;
  $('cmd-json').textContent = JSON.stringify({ mcpServers: { 'kyte-webmcp': { command: 'node', args: [path] } } }, null, 2);
  $('ports').textContent = t('portsInfo', [String(state.ports[0]), String(state.ports[1])]);
  $('version').textContent = t('versionInfo', [state.extVersion, state.extensionId]);
}

function renderAll(): void {
  renderStatus();
  renderSessions();
  renderActivity();
  renderWebmcp();
  renderSettings();
  renderLan();
  renderSetup();
  requestAnimationFrame(() => document.body.classList.remove('loading'));
}

localize();
$('filter').addEventListener('input', (e) => {
  filter = (e.target as HTMLInputElement).value;
  renderActivity();
});
$('set-overlay').addEventListener('change', (e) => send({ type: 'settings', patch: { overlay: (e.target as HTMLInputElement).checked } }));
$('set-whisper').addEventListener('change', (e) => send({ type: 'settings', patch: { whisperModel: (e.target as HTMLSelectElement).value } }));
$('set-lan').addEventListener('change', (e) => send({ type: 'settings', patch: { lan: (e.target as HTMLInputElement).checked } }));
$('lan-address').addEventListener('change', (e) => {
  lanAddress = (e.target as HTMLSelectElement).value;
  renderLan();
});
$('lan-new-token').addEventListener('click', () => send({ type: 'lanNewToken' }));
$('setup').addEventListener('toggle', () => ($('setup').dataset.touched = '1'));
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText($(button.dataset.copy!).textContent ?? '');
    button.textContent = t('copied');
    setTimeout(() => (button.textContent = t('copy')), 1500);
  });
}
/** The tab the user is looking at: the active tab of the last focused normal browser window. */
async function refreshActiveTab(): Promise<void> {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
    activeTabId = win.tabs?.find((tab) => tab.active)?.id ?? null;
  } catch {
    activeTabId = null;
  }
  renderWebmcp();
}
void refreshActiveTab();
chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
chrome.windows.onFocusChanged.addListener(() => void refreshActiveTab());
void chrome.storage.local.get('bridgeCliPath').then((v) => {
  cliPath = (v.bridgeCliPath as string) ?? '';
  renderSetup();
  renderLan();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.bridgeCliPath) {
    cliPath = changes.bridgeCliPath.newValue as string;
    renderSetup();
    renderLan();
  }
});
connect();

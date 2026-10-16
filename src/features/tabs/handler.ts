import type { Feature } from '../../extension/background/types.ts';
import { ToolError } from '../../extension/background/util.ts';
import { resolveTargetTab } from '../../extension/background/sessions.ts';

export const tabsFeature: Feature = {
  name: 'tabs',
  handlers: {
    async tabs_list(args: { currentWindowOnly?: boolean }, { session, core }) {
      const tabs = await chrome.tabs.query(args.currentWindowOnly ? { lastFocusedWindow: true } : {});
      const target = await resolveTargetTab(session, undefined).catch(() => null);
      const groups = new Map<number, string>();
      for (const g of await chrome.tabGroups.query({})) groups.set(g.id, g.title || `group ${g.id}`);
      const owners = new Map<number, string>();
      for (const s of core.sessions.values()) for (const [, gid] of s.groups) owners.set(gid, s.name);
      const lines = tabs.map((tab) => {
        const flags = [
          tab.id === target ? 'TARGET' : '',
          tab.active ? 'active' : '',
          tab.audible ? 'audible' : '',
          tab.status === 'loading' ? 'loading' : '',
          tab.groupId !== undefined && tab.groupId >= 0 ? `group "${groups.get(tab.groupId) ?? tab.groupId}"${owners.has(tab.groupId) ? ' (agent)' : ''}` : '',
        ].filter(Boolean);
        return `${tab.id} [window ${tab.windowId}] ${tab.title || '(no title)'} — ${tab.pendingUrl || tab.url || ''}${flags.length ? `  {${flags.join(', ')}}` : ''}`;
      });
      const mode = session.targetTabId === null ? 'follows the tab the user is looking at' : `fixed to tab ${session.targetTabId}`;
      return `${tabs.length} tabs. Session target ${mode}.\n${lines.join('\n')}`;
    },

    async tab_open(args: { url: string; background?: boolean; waitUntil?: string; timeoutMs?: number }, { session, core, signal }) {
      const started = Date.now();
      let url = args.url.trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      // Web pages start on about:blank so the debugger is attached before they load: the console,
      // network and security details then include the page load itself.
      const web = /^https?:/i.test(url);
      const tab = await chrome.tabs.create({ url: web ? 'about:blank' : url, active: !args.background });
      if (tab.id === undefined) throw new ToolError('Chrome did not create the tab.');
      await session.addToGroup(tab.id);
      core.setTarget(session, tab.id);
      session.touchedTabs.add(tab.id);
      const waitUntil = args.waitUntil ?? 'load';
      const timeoutMs = args.timeoutMs ?? 30_000;
      if (web && (await core.cdp.ensure(tab.id).then(() => true, () => false))) {
        const loadStart = Date.now();
        const res = await core.cdp.send(tab.id, 'Page.navigate', { url });
        if (res.errorText) throw new ToolError(`Opened tab ${tab.id}, but loading ${url} failed: ${res.errorText}`);
        if (res.loaderId) await core.life.waitForLoad(tab.id, loadStart, waitUntil, timeoutMs, signal, res.loaderId);
        await core.cdp.send(tab.id, 'Page.resetNavigationHistory').catch(() => {}); // "back" must not lead to the blank start page
      } else if (waitUntil !== 'none') {
        if (web) await chrome.tabs.update(tab.id, { url });
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const t = await chrome.tabs.get(tab.id);
          if (t.status === 'complete' && !t.pendingUrl && (t.url || '') !== 'about:blank') break;
          if (Date.now() > deadline) throw new ToolError(`Tab ${tab.id} opened but did not finish loading within ${timeoutMs} ms.`);
          await new Promise((r) => setTimeout(r, 100));
          if (signal.aborted) throw new ToolError('Cancelled');
        }
      } else if (web) await chrome.tabs.update(tab.id, { url });
      const done = await chrome.tabs.get(tab.id);
      return `Opened tab ${tab.id}: ${done.title || '(no title)'} — ${done.url || done.pendingUrl} (${Date.now() - started} ms). It is now the session target tab and sits in the "${session.name}" tab group.`;
    },

    async tab_select(args: { tabId: number; activate?: boolean }, { session, core }) {
      const tab = await chrome.tabs.get(args.tabId).catch(() => null);
      if (!tab) throw new ToolError(`Tab ${args.tabId} does not exist.`);
      core.setTarget(session, args.tabId);
      if (args.activate) {
        await chrome.tabs.update(args.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return `Tab ${args.tabId} (${tab.title}) is now the session target${args.activate ? ' and is active' : ''}.`;
    },

    async tab_close(args: { tabIds: number[] }) {
      const closed: number[] = [];
      const missing: number[] = [];
      for (const id of args.tabIds) {
        try {
          await chrome.tabs.remove(id);
          closed.push(id);
        } catch {
          missing.push(id);
        }
      }
      return `Closed ${closed.length ? closed.join(', ') : 'nothing'}${missing.length ? `; not found: ${missing.join(', ')}` : ''}.`;
    },
  },
};

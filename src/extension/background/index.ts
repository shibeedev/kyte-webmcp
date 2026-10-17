import { Core } from './core.ts';
import { extensionFeatures } from '../../features/extension.ts';

const core = new Core(extensionFeatures);
void core.start();

// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Wake up periodically while no bridge is connected so a newly started MCP client is found quickly.
chrome.alarms.create('kyte-webmcp-scan', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'kyte-webmcp-scan') core.connections.scan();
});
// Ordinary browsing events also wake a stopped worker, so a new MCP client is found within seconds.
chrome.tabs.onActivated.addListener(() => core.connections.scan());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === 'loading') core.connections.scan();
});
chrome.windows.onFocusChanged.addListener(() => core.connections.scan());

// Exposed for debugging from the service worker console and for tests.
(globalThis as unknown as { kyteCore: Core }).kyteCore = core;

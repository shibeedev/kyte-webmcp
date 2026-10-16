import type { Feature } from '../../extension/background/types.ts';
import { ToolError, sleep } from '../../extension/background/util.ts';

function isVisibleText(text: string): boolean {
  // Runs in the page (isolated world): true when the text is rendered somewhere visible.
  const needle = text.toLowerCase();
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) continue;
    const el = node.parentElement;
    if (!el) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  // Text inside form controls.
  for (const input of Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[]) {
    if (input.value && input.value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function selectorVisible(selector: string): boolean {
  const el = document.querySelector(selector);
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function pageState() {
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    lang: document.documentElement.lang || navigator.language,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
    documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    charset: document.characterSet,
    contentType: document.contentType,
    referrer: document.referrer,
  };
}

interface FrameNode {
  frame: { id: string; url: string; name?: string; securityOrigin?: string };
  childFrames?: FrameNode[];
}

export const navigationFeature: Feature = {
  name: 'navigation',
  handlers: {
    async navigate(args: { url?: string; action?: 'back' | 'forward' | 'reload'; waitUntil?: string; ignoreCache?: boolean; timeoutMs?: number }, { core, tabId, signal }) {
      if (!args.url && !args.action) throw new ToolError('Give either url or action.');
      await core.cdp.ensure(tabId);
      const waitUntil = args.waitUntil ?? 'load';
      const timeoutMs = args.timeoutMs ?? 30_000;
      const started = Date.now();
      const life = core.life.get(tabId);
      let sameDocument = false;
      let loaderId: string | undefined;
      if (args.url) {
        let url = args.url.trim();
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
        const res = await core.cdp.send(tabId, 'Page.navigate', { url });
        if (res.errorText) throw new ToolError(`Navigation to ${url} failed: ${res.errorText}`);
        loaderId = res.loaderId;
        sameDocument = !res.loaderId;
      } else if (args.action === 'reload') {
        await core.cdp.send(tabId, 'Page.reload', { ignoreCache: !!args.ignoreCache });
      } else {
        const { currentIndex, entries } = await core.cdp.send(tabId, 'Page.getNavigationHistory');
        const index = currentIndex + (args.action === 'back' ? -1 : 1);
        if (index < 0 || index >= entries.length) throw new ToolError(`There is no page to go ${args.action} to.`);
        await core.cdp.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entries[index].id });
        await sleep(150, signal);
        sameDocument = life.navigatedAt < started;
      }
      if (!sameDocument) await core.life.waitForLoad(tabId, started, waitUntil, timeoutMs, signal, loaderId);
      const tab = await chrome.tabs.get(tabId);
      const doc = life.documentResponse && life.documentResponse.at >= started ? life.documentResponse : undefined;
      const dialog = core.life.dialog(tabId);
      const parts = [
        `${tab.url}`,
        `title: ${tab.title || '(none)'}`,
        doc ? `HTTP ${doc.status}${doc.statusText ? ` ${doc.statusText}` : ''}` : sameDocument ? 'same-document navigation' : '',
        `${Date.now() - started} ms`,
      ].filter(Boolean);
      return `Loaded ${parts.join(' · ')}${dialog ? `\nA ${dialog.type} dialog is open: "${dialog.message}" — use the dialog tool.` : ''}`;
    },

    async wait_for(args: { text?: string; textGone?: string; selector?: string; networkIdle?: boolean; timeMs?: number; timeoutMs?: number }, { core, tabId, signal }) {
      const timeoutMs = args.timeoutMs ?? 10_000;
      const started = Date.now();
      if (args.timeMs) await sleep(Math.min(args.timeMs, timeoutMs), signal);
      if (args.text || args.textGone || args.selector || args.networkIdle) await core.cdp.ensure(tabId);
      const deadline = started + timeoutMs;
      if (args.networkIdle) await core.life.waitForNetworkIdle(tabId, 500, timeoutMs, signal);
      const checks: Array<[string, () => Promise<boolean>]> = [];
      if (args.text) checks.push([`text "${args.text}" to appear`, async () => core.page.evaluate<boolean>(tabId, isVisibleText, [args.text])]);
      if (args.textGone) checks.push([`text "${args.textGone}" to disappear`, async () => !(await core.page.evaluate<boolean>(tabId, isVisibleText, [args.textGone]))]);
      if (args.selector) checks.push([`selector ${args.selector}`, async () => core.page.evaluate<boolean>(tabId, selectorVisible, [args.selector])]);
      for (const [label, check] of checks) {
        for (;;) {
          if (core.life.dialog(tabId)) throw new ToolError('A JavaScript dialog is open; handle it with the dialog tool first.');
          let ok = false;
          try {
            ok = await check();
          } catch {
            ok = false; // page navigating: retry
          }
          if (ok) break;
          if (Date.now() > deadline) throw new ToolError(`Timed out after ${timeoutMs} ms waiting for ${label}.`);
          await sleep(150, signal);
        }
      }
      return `Done after ${Date.now() - started} ms.`;
    },

    async page_info(_args, { core, tabId }) {
      await core.cdp.ensure(tabId);
      const state = await core.page.evaluate<ReturnType<typeof pageState>>(tabId, pageState);
      const { frameTree } = await core.cdp.send(tabId, 'Page.getFrameTree');
      const lines: string[] = [];
      const walk = (node: FrameNode, depth: number) => {
        lines.push(`${'  '.repeat(depth)}- frame ${node.frame.id.slice(0, 8)} ${node.frame.name ? `"${node.frame.name}" ` : ''}${node.frame.url}`);
        for (const c of node.childFrames ?? []) walk(c, depth + 1);
      };
      walk(frameTree, 0);
      const oopifs = core.cdp.children(tabId).filter((c) => c.type === 'iframe');
      const workers = core.cdp.children(tabId).filter((c) => c.type !== 'iframe');
      const doc = core.life.get(tabId).documentResponse;
      const sec = doc?.security;
      const security = doc
        ? `Main document: HTTP ${doc.status} ${doc.url}${doc.protocol ? ` · ${doc.protocol}` : ''}${doc.remoteAddress ? ` · ${doc.remoteAddress}` : ''}${
            sec ? `\nTLS: ${sec.protocol} ${sec.cipher} · certificate "${sec.subjectName}" issued by ${sec.issuer}, valid until ${new Date(sec.validTo * 1000).toISOString().slice(0, 10)}` : ''
          }`
        : 'Main document response not captured (it loaded before the agent attached; reload to capture it).';
      return [
        `URL: ${state.url}`,
        `Title: ${state.title}`,
        `Ready state: ${state.readyState} · language ${state.lang} · ${state.contentType} · ${state.charset}`,
        `Viewport: ${state.viewport.width}×${state.viewport.height} @${state.viewport.devicePixelRatio}x · scroll ${state.scroll.x},${state.scroll.y} · document ${state.documentSize.width}×${state.documentSize.height}`,
        security,
        `Frames (same-process tree):`,
        ...lines,
        oopifs.length ? `Out-of-process iframes (sessions for cdp_send):\n${oopifs.map((c) => `  - session ${c.sessionId} ${c.url}`).join('\n')}` : 'Out-of-process iframes: none',
        workers.length ? `Workers:\n${workers.map((c) => `  - ${c.type} session ${c.sessionId} ${c.url}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
};

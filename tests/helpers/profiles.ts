/**
 * Two real profiles in one Chrome for Testing, each running the test extension: the situation where several
 * copies of the extension (same id, separate storage and service workers) look for the same bridges.
 * Chrome is started directly (Puppeteer's own launch flags prevent opening a second profile); a second launch
 * with the same user data dir hands over to the running browser and opens a window in "Profile 1".
 * Headful: Chrome only opens a second profile with a window.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page, type Target, type WebWorker } from 'puppeteer-core';
import { CHROME, EXT_DIR, TEST_ENV, sleep } from './harness.ts';
import { EXTENSION_ID } from '../../src/shared/constants.ts';

export interface ProfileHandle {
  label: string;
  contextId: string;
  /** The profile's extension service worker (found again after it restarts), with kyteCore ready. */
  worker(): Promise<WebWorker>;
  /** Navigates a tab of this profile (wakes its service worker; CDP cannot open tabs in a real profile). */
  navigate(url: string): Promise<Page>;
  /** The side panel of this profile, opened as a popup window. */
  sidePanel(): Promise<Page>;
  /** Session names this profile's extension currently has. */
  sessions(): Promise<string[]>;
  /** URLs of the tabs open in this profile. */
  tabUrls(): Promise<string[]>;
}

export interface TwoProfiles {
  browser: Browser;
  profiles: [ProfileHandle, ProfileHandle];
  close(): Promise<void>;
}

const targetId = (t: Target) => (t as unknown as { _targetId: string })._targetId;

export async function launchTwoProfiles(opts: { lang?: string } = {}): Promise<TwoProfiles> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'kyte-webmcp-profiles-'));
  const base = [`--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', `--load-extension=${EXT_DIR}`, '--window-size=900,700',
    // Windows stops painting covered windows; the side panels opened here are often covered by other test windows.
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ...(opts.lang ? [`--lang=${opts.lang}`] : [])];
  const env = { ...process.env, ...TEST_ENV };
  const main: ChildProcess = spawn(CHROME, [...base, '--remote-debugging-port=0', '--profile-directory=Default', 'about:blank'], { env, stdio: 'ignore' });
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; !existsSync(portFile) || !readFileSync(portFile, 'utf8').includes('\n'); i++) {
    if (i > 200) throw new Error('Chrome did not start');
    await sleep(100);
  }
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 30_000 });
  spawn(CHROME, [...base, '--profile-directory=Profile 1', 'about:blank'], { env, stdio: 'ignore' });

  const cdp = await browser.target().createCDPSession();
  /** Browser context id of every extension service worker, from Chrome itself (covers every profile). */
  const swContexts = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`)).map((t) => ({ id: t.targetId, context: t.browserContextId! }));
  };
  let found: Array<{ id: string; context: string }> = [];
  for (let i = 0; i < 300 && found.length < 2; i++) {
    found = await swContexts();
    if (found.length < 2) await sleep(100);
  }
  if (found.length < 2) throw new Error(`expected the extension in two profiles, found ${found.length}`);
  const defaultContext = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page')?.browserContextId;
  found.sort((a, b) => Number(b.context === defaultContext) - Number(a.context === defaultContext));

  const handle = (label: string, contextId: string): ProfileHandle => {
    const worker = async (): Promise<WebWorker> => {
      for (let i = 0; i < 200; i++) {
        const sw = (await swContexts()).find((s) => s.context === contextId);
        const target = sw && browser.targets().find((t) => targetId(t) === sw.id);
        const w = await target?.worker().catch(() => null);
        // A worker Chrome just stopped can leave a stale target whose evaluate never answers: bound the check.
        const ready = w && (await Promise.race([w.evaluate(() => typeof (globalThis as any).kyteCore).catch(() => ''), sleep(2000).then(() => '')]));
        if (w && ready === 'object') {
          await w.evaluate(() => (globalThis as any).kyteCore.settings.ready);
          return w;
        }
        await sleep(100);
      }
      throw new Error(`no extension worker in ${label}`);
    };
    const pageFor = async (id: string): Promise<Page> => {
      const target = await browser.waitForTarget((t) => targetId(t) === id);
      return (await target.page())!;
    };
    return {
      label,
      contextId,
      worker,
      navigate: async (url) => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const tab = targetInfos.find((t) => t.type === 'page' && t.browserContextId === contextId && !t.url.startsWith('chrome-extension://'));
        if (!tab) throw new Error(`no tab in ${label}`);
        const page = await pageFor(tab.targetId);
        await page.goto(url);
        return page;
      },
      sidePanel: async () => {
        const w = await worker();
        await w.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', width: 420, height: 900 }));
        let id = '';
        for (let i = 0; i < 100 && !id; i++) {
          const { targetInfos } = await cdp.send('Target.getTargets');
          id = targetInfos.find((t) => t.browserContextId === contextId && t.url.endsWith('/sidepanel.html'))?.targetId ?? '';
          if (!id) await sleep(100);
        }
        const page = await pageFor(id);
        await page.setViewport({ width: 400, height: 1300 });
        await page.waitForFunction(() => document.getElementById('status-text')?.textContent !== '');
        return page;
      },
      sessions: async () => (await worker()).evaluate(() => (globalThis as any).kyteCore.sessionList().map((s: { name: string }) => s.name)),
      tabUrls: async () => (await worker()).evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url ?? t.pendingUrl ?? '')),
    };
  };

  return {
    browser,
    profiles: [handle('Default', found[0]!.context), handle('Profile 1', found[1]!.context)],
    close: async () => {
      await browser.close().catch(() => {});
      main.kill();
      await sleep(500);
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* Windows may still hold files briefly */
      }
    },
  };
}

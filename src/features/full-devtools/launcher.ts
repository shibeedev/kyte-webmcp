/**
 * `neo-webmcp chrome`: starts the installed Chrome with a dedicated profile
 * folder and remote debugging on. Chrome only refuses remote debugging for
 * the *default* profile, so this profile gives the full DevTools channel
 * without any consent prompt. Logins made in it persist.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { WebSocket } from 'ws';
import { EXTENSION_ID } from '../../shared/constants.ts';
import { agentProfileDir, readActivePort } from './discovery.ts';

export function findChrome(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function extensionLoaded(wsUrl: string): Promise<boolean> {
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const targets = await new Promise<Array<{ url: string }>>((resolve) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as { id: number; result?: { targetInfos: Array<{ url: string }> } };
        if (m.id === 1) resolve(m.result?.targetInfos ?? []);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets', params: {} }));
    });
    return targets.some((t) => t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
  } finally {
    ws.close();
  }
}

export async function launchAgentChrome(options: { chromePath?: string; profileDir?: string; extensionDir: string; url?: string }): Promise<void> {
  const chrome = options.chromePath ?? findChrome();
  if (!chrome) throw new Error('Chrome was not found; pass --chrome-path');
  const profile = options.profileDir ?? agentProfileDir();
  mkdirSync(profile, { recursive: true });
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    // Honoured by Chromium/Chrome for Testing; branded Chrome ignores it, then a one-time "Load unpacked" is needed.
    `--load-extension=${options.extensionDir}`,
    options.url ?? 'about:blank',
  ];
  spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref();
  let wsUrl: string | null = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 150));
    wsUrl = readActivePort(profile);
  }
  if (!wsUrl) throw new Error('Chrome started but did not open its remote debugging port');
  process.stderr.write(`Agent Chrome is running with profile ${profile}\nFull DevTools endpoint: ${wsUrl}\n`);
  await new Promise((r) => setTimeout(r, 1500));
  if (await extensionLoaded(wsUrl).catch(() => false)) {
    process.stderr.write('The Neo WebMCP extension is loaded in this profile. Full DevTools access needs no prompts.\n');
  } else {
    process.stderr.write(
      `One-time step: in the window that opened, go to chrome://extensions, turn on "Developer mode", click "Load unpacked" and choose:\n  ${options.extensionDir}\nChrome remembers it for this profile.\n`,
    );
  }
}

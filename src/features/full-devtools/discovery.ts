import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Folder of the dedicated agent profile started by `kyte-webmcp chrome` (non-default user data dir → no consent prompt). */
export function agentProfileDir(): string {
  return path.join(os.homedir(), '.kyte-webmcp', 'chrome-profile');
}

/** Default user data directories of Chrome-family browsers, most likely first. */
export function defaultUserDataDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome SxS', 'Chromium', 'Microsoft/Edge'].map((p) => path.join(local, p, 'User Data'));
  }
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'Microsoft Edge'].map((p) => path.join(support, p));
  }
  const config = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'microsoft-edge'].map((p) => path.join(config, p));
}

export interface Endpoint {
  wsUrl: string;
  source: string;
  /** True when Chrome will not ask the user (non-default profile or explicit endpoint). */
  silent: boolean;
}

/** Reads `DevToolsActivePort` (line 1: port, line 2: browser target path) written by Chrome when remote debugging is on. */
export function readActivePort(userDataDir: string): string | null {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const [port, browserPath] = readFileSync(file, 'utf8').split(/\r?\n/);
  if (!/^\d+$/.test(port ?? '') || !browserPath?.startsWith('/devtools/browser/')) return null;
  return `ws://127.0.0.1:${port}${browserPath}`;
}

/** Where a bridge was told to look (its KYTE_WEBMCP_CDP_ENDPOINT / KYTE_WEBMCP_CHROME_USER_DATA_DIR). */
export interface EndpointHints {
  endpoint?: string;
  userDataDir?: string;
}

/**
 * Candidate remote-debugging endpoints in priority order: explicit settings
 * (the requesting bridge's, then the broker's own), the dedicated agent
 * profile, then the user's normal profiles (those make Chrome ask for consent
 * once per connection).
 */
export function discoverEndpoints(hints: EndpointHints = {}): Endpoint[] {
  const out: Endpoint[] = [];
  for (const explicit of new Set([hints.endpoint, process.env.KYTE_WEBMCP_CDP_ENDPOINT])) {
    if (explicit) out.push({ wsUrl: explicit, source: 'KYTE_WEBMCP_CDP_ENDPOINT', silent: true });
  }
  for (const userDir of new Set([hints.userDataDir, process.env.KYTE_WEBMCP_CHROME_USER_DATA_DIR])) {
    const ws = userDir ? readActivePort(userDir) : null;
    if (ws) out.push({ wsUrl: ws, source: userDir!, silent: true });
  }
  // Test runs must never reach (or prompt in) the user's own browsers: explicit endpoints only.
  if (process.env.KYTE_WEBMCP_NO_DEFAULT_PROFILES === '1') return out;
  const agent = readActivePort(agentProfileDir());
  if (agent) out.push({ wsUrl: agent, source: 'agent profile', silent: true });
  for (const dir of defaultUserDataDirs()) {
    const ws = readActivePort(dir);
    if (ws) out.push({ wsUrl: ws, source: dir, silent: false });
  }
  return out;
}

/** E2E harness: Chrome for Testing with the built extension + a real MCP client running the bridge over stdio. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type WebWorker } from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket as WsClient } from 'ws';
import { EXTENSION_ID } from '../../src/shared/constants.ts';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
// The test build (npm run test:e2e builds it) moves the bridge ports up by 100: test bridges and the test
// extension never meet the extension in the user's own Chrome or the user's own running bridges.
export const EXT_DIR = path.join(ROOT, 'dist-test', 'extension');
export const CLI = path.join(ROOT, 'dist-test', 'bridge', 'cli.mjs');
const TEST_PORT_SHIFT = 100;

/** The port a test bridge started with startClient(port) really listens on. */
export const bridgePort = (port: number) => port + TEST_PORT_SHIFT;
export const CHROME = process.env.KYTE_TEST_CHROME ?? path.join(ROOT, '.cache', 'chrome', 'chrome', 'win64-155.0.8059.41', 'chrome-win64', 'chrome.exe');
export const ARTIFACTS = path.join(ROOT, 'tests', '.artifacts');

export interface BrowserHandle {
  browser: Browser;
  userDataDir: string;
  close(): Promise<void>;
}

export async function launchBrowser(opts: { headless?: boolean; args?: string[]; extensions?: boolean; lang?: string; webmcp?: boolean; downloadDir?: string; devtools?: boolean; unmuted?: boolean } = {}): Promise<BrowserHandle> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'kyte-webmcp-test-'));
  if (opts.downloadDir) {
    // Like a user setting a download folder: keeps test downloads out of the real Downloads folder.
    mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: opts.downloadDir, prompt_for_download: false, directory_upgrade: true } }));
  }
  const headless = opts.headless ?? !process.env.HEADFUL;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: opts.devtools ? false : headless,
    devtools: !!opts.devtools,
    pipe: true,
    enableExtensions: opts.extensions === false ? false : [EXT_DIR],
    userDataDir,
    defaultViewport: null,
    // Puppeteer mutes headless tabs; tab audio capture needs their sound.
    ...(opts.unmuted ? { ignoreDefaultArgs: ['--mute-audio'] } : {}),
    args: ['--no-first-run', '--no-default-browser-check', ...(opts.webmcp === false ? ['--disable-features=WebMCP'] : ['--enable-features=WebMCP']), ...(opts.args?.some((a) => a.startsWith('--window-size')) ? [] : ['--window-size=1280,900']), ...(opts.lang ? [`--lang=${opts.lang}`] : []), ...(opts.args ?? [])],
  });
  if (process.env.DEBUG_SW && opts.extensions !== false) {
    // Mirror the extension service worker console to stderr while debugging tests.
    void extensionWorker(browser).then((w) => w.on('console', (m) => process.stderr.write(`[sw ${m.type()}] ${m.text()}\n`)));
  }
  return {
    browser,
    userDataDir,
    close: async () => {
      await browser.close().catch(() => {});
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* Windows may still hold files briefly */
      }
    },
  };
}

/** The extension's service worker, ready to evaluate (kyteCore is exposed for tests). */
export async function extensionWorker(browser: Browser): Promise<WebWorker> {
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${EXTENSION_ID}/`), { timeout: 20_000 });
  const worker = (await target.worker())!;
  for (let i = 0; i < 100; i++) {
    if ((await worker.evaluate(() => typeof (globalThis as any).kyteCore).catch(() => 'undefined')) === 'object') return worker;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('extension core did not start');
}

export interface McpHandle {
  client: Client;
  stderr: string[];
  close(): Promise<void>;
}

export async function startClient(port: number, opts: { env?: Record<string, string>; name?: string } = {}): Promise<McpHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--port', String(bridgePort(port))],
    env: {
      ...(process.env as Record<string, string>),
      KYTE_WEBMCP_OUTPUT_DIR: path.join(ARTIFACTS, 'output'),
      // Isolation: the test broker keeps its own state and never looks at the user's real Chrome profiles.
      KYTE_WEBMCP_STATE_DIR: path.join(ARTIFACTS, 'state'),
      KYTE_WEBMCP_NO_DEFAULT_PROFILES: '1',
      ...(opts.env ?? {}),
    },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (d: Buffer) => stderr.push(String(d)));
  const client = new Client({ name: opts.name ?? 'kyte-e2e', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr, close: () => client.close() };
}

export interface CallResult {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  isError: boolean;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const content = res.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  return {
    text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    images: content.filter((c) => c.type === 'image').map((c) => ({ data: c.data!, mimeType: c.mimeType! })),
    isError: !!res.isError,
  };
}

/** Calls a tool and fails the test with the tool's message when it reports an error. */
export async function ok(client: Client, name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<CallResult> {
  const r = await call(client, name, args, timeoutMs);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r;
}

export async function waitConnected(client: Client, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call(client, 'browser_status');
    if (r.text.includes('Extension: connected')) return;
    if (Date.now() > deadline) throw new Error(`extension did not connect: ${r.text}`);
    await new Promise((res) => setTimeout(res, 300));
  }
}

/** Extracts the ref of the first snapshot line matching `pattern`. */
export function refOf(snapshot: string, pattern: RegExp): string {
  const line = snapshot.split('\n').find((l) => pattern.test(l));
  const m = line?.match(/\[ref=(e\d+)\]/);
  if (!m) throw new Error(`no ref for ${pattern} in:\n${snapshot.slice(0, 3000)}`);
  return m[1]!;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tries to open a WebSocket from Node with the given headers: "open", or "refused …" with the reason. */
export function wsAttempt(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WsClient(url, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(`refused ${res.statusCode}`));
    ws.on('error', (error) => resolve(`refused ${(error as NodeJS.ErrnoException).code ?? error.message}`));
  });
}

/** A non-loopback IPv4 address of this machine, to prove a server is not reachable from the network. */
export function lanAddress(): string | undefined {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
}

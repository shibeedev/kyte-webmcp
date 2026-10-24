import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_ORIGIN, NATIVE_HOST } from '../shared/constants.ts';

/**
 * Chrome native messaging: registering the LAN host so the extension can start
 * it, and the stdio framing (4-byte little-endian length + UTF-8 JSON).
 */

const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`;

function hostDir(): string {
  return path.join(process.env.KYTE_WEBMCP_STATE_DIR ?? path.join(os.homedir(), '.kyte-webmcp'), 'native-host');
}

/** Where Chrome looks for the host manifest on macOS and Linux (Windows uses the registry). */
function chromeManifestDir(): string {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
    : path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
}

/** Registers the LAN host for the current user. Returns what was written, for the CLI to print. */
export function installNativeHost(cliPath: string): string[] {
  const dir = hostDir();
  mkdirSync(dir, { recursive: true });
  const windows = process.platform === 'win32';
  // Chrome passes its own arguments to the host; the launcher drops them.
  const launcher = path.join(dir, `${NATIVE_HOST}${windows ? '.cmd' : '.sh'}`);
  if (windows) writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${cliPath}" lan-host\r\n`);
  else {
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" lan-host\n`);
    chmodSync(launcher, 0o755);
  }
  const manifest = { name: NATIVE_HOST, description: 'Kyte WebMCP LAN endpoint', path: launcher, type: 'stdio', allowed_origins: [`${EXTENSION_ORIGIN}/`] };
  const manifestPath = path.join(windows ? dir : chromeManifestDir(), `${NATIVE_HOST}.json`);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const written = [launcher, manifestPath];
  if (windows) {
    execFileSync('reg', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
    written.push(REG_KEY);
  }
  return written;
}

export function uninstallNativeHost(): string[] {
  const removed: string[] = [];
  if (process.platform === 'win32') {
    try {
      execFileSync('reg', ['delete', REG_KEY, '/f'], { stdio: 'ignore' });
      removed.push(REG_KEY);
    } catch {
      /* not registered */
    }
  } else {
    const manifestPath = path.join(chromeManifestDir(), `${NATIVE_HOST}.json`);
    rmSync(manifestPath, { force: true });
    removed.push(manifestPath);
  }
  rmSync(hostDir(), { recursive: true, force: true });
  removed.push(hostDir());
  return removed;
}

export function encodeNative(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Reassembles native messages from stdin chunks. */
export class NativeReader {
  #buffer = Buffer.alloc(0);
  readonly #onMessage: (message: unknown) => void;

  constructor(onMessage: (message: unknown) => void) {
    this.#onMessage = onMessage;
  }

  push(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (this.#buffer.length < 4 + length) return;
      const body = this.#buffer.subarray(4, 4 + length).toString('utf8');
      this.#buffer = this.#buffer.subarray(4 + length);
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        continue; // ignore malformed messages
      }
      this.#onMessage(message);
    }
  }
}

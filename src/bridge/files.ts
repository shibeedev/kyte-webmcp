import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ServiceHandler } from './hub.ts';

export function defaultOutputDir(): string {
  return path.join(os.homedir(), '.kyte-webmcp', 'output');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/** Picks the destination: the agent's absolute path, or `<outputDir>/<stem>-<timestamp>.<ext>`. */
export function resolveTarget(outputDir: string, requested: unknown, stem: string, ext: string): string {
  if (typeof requested === 'string' && requested.trim()) {
    const p = path.resolve(requested.trim());
    mkdirSync(path.dirname(p), { recursive: true });
    return p;
  }
  mkdirSync(outputDir, { recursive: true });
  const safeStem = stem.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'file';
  return path.join(outputDir, `${safeStem}-${timestamp()}.${ext}`);
}

function decode(data: unknown, encoding: unknown): Buffer {
  if (typeof data !== 'string') throw new Error('data must be a string');
  return encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
}

/** File services the extension uses to save screenshots, HAR, traces, PDFs… on the bridge's machine. */
export function fileServices(outputDir: string): Record<string, ServiceHandler> {
  const open = new Map<number, { fd: number; path: string; bytes: number }>();
  let nextHandle = 1;
  return {
    'file.write': async (a) => {
      const target = resolveTarget(outputDir, a.path, String(a.stem ?? 'file'), String(a.ext ?? 'bin'));
      const buf = decode(a.data, a.encoding);
      const fd = openSync(target, 'w');
      try {
        writeSync(fd, buf);
      } finally {
        closeSync(fd);
      }
      return { path: target, bytes: buf.length };
    },
    'file.open': async (a) => {
      const target = resolveTarget(outputDir, a.path, String(a.stem ?? 'file'), String(a.ext ?? 'bin'));
      const handle = nextHandle++;
      open.set(handle, { fd: openSync(target, 'w'), path: target, bytes: 0 });
      return { handle, path: target };
    },
    'file.append': async (a) => {
      const f = open.get(Number(a.handle));
      if (!f) throw new Error('Unknown file handle');
      const buf = decode(a.data, a.encoding);
      writeSync(f.fd, buf);
      f.bytes += buf.length;
      return { bytes: f.bytes };
    },
    'file.close': async (a) => {
      const f = open.get(Number(a.handle));
      if (!f) throw new Error('Unknown file handle');
      closeSync(f.fd);
      open.delete(Number(a.handle));
      return { path: f.path, bytes: f.bytes };
    },
  };
}

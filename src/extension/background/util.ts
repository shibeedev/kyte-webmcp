import type { ToolContent, ToolResult } from '../../shared/protocol.ts';

/** An error whose message is meant for the agent as-is. */
export class ToolError extends Error {}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolError('Cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ToolError('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolError(message)), ms);
    }),
  ]);
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ToolError('Cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ToolError('Cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Polls `check` until it returns a non-undefined value or the timeout passes. */
export async function waitUntil<T>(check: () => Promise<T | undefined> | T | undefined, opts: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal; message: string }): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new ToolError(opts.message);
    await sleep(opts.intervalMs ?? 100, opts.signal);
  }
}

export function truncate(text: string, max: number, hint = ''): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} more characters${hint ? `; ${hint}` : ''}]`;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function imageContent(data: string, mimeType: string): ToolContent {
  return { type: 'image', data, mimeType };
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSeconds(s: number): string {
  if (!Number.isFinite(s)) return 'live';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

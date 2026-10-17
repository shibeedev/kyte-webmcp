/** stdout carries the MCP stdio stream, so every diagnostic goes to stderr. */
export function log(...parts: unknown[]): void {
  const text = parts.map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  process.stderr.write(`[kyte-webmcp] ${text}\n`);
}

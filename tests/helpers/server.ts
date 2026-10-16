/** Static fixture server with a few API routes and HTTP Range support (needed for video seeking). */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..', 'fixtures', 'site');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt',
  '.txt': 'text/plain; charset=utf-8',
};

// 1×1 PNG
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export interface FixtureServers {
  a: string;
  b: string;
  portA: number;
  portB: number;
  requests: string[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function handler(getPorts: () => { a: number; b: number }, requests: string[]) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push(`${req.method} ${url.pathname}`);
    try {
      if (url.pathname === '/api/echo') {
        const body = await readBody(req);
        res.writeHead(200, { 'content-type': 'application/json', 'x-test-header': 'yes' });
        res.end(JSON.stringify({ method: req.method, body, headers: req.headers }));
        return;
      }
      if (url.pathname === '/api/error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'server exploded' }));
        return;
      }
      if (url.pathname === '/api/slow') {
        await new Promise((r) => setTimeout(r, Number(url.searchParams.get('ms') ?? 1000)));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('slow done');
        return;
      }
      if (url.pathname === '/img/pixel.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PIXEL);
        return;
      }
      if (url.pathname === '/llms.txt' && url.searchParams.has('missing')) {
        res.writeHead(404).end();
        return;
      }
      // Hotlink-protected copy: served to media elements only, so the extension cannot download it directly.
      if (url.pathname === '/media/protected.webm' && !['video', 'audio'].includes(String(req.headers['sec-fetch-dest']))) {
        res.writeHead(403).end();
        return;
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname === '/media/protected.webm' ? '/media/sample.webm' : url.pathname;
      const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
      }
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
      if (type.startsWith('text/html')) {
        const ports = getPorts();
        const html = (await readFile(file, 'utf8')).replaceAll('{{PORT_B}}', String(ports.b)).replaceAll('{{PORT_A}}', String(ports.a));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Number(range[2]) : info.size - 1;
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': info.size });
      createReadStream(file).pipe(res);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  };
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as { port: number }).port)));
}

/** Origin A on localhost, origin B on 127.0.0.1: different sites, so B iframes are out-of-process. */
export async function startFixtureServers(): Promise<FixtureServers> {
  const requests: string[] = [];
  const ports = { a: 0, b: 0 };
  const sa = createServer(handler(() => ports, requests));
  const sb = createServer(handler(() => ports, requests));
  // WebSocket echo for the Network panel tests.
  const wss = new WebSocketServer({ server: sa, path: '/ws' });
  wss.on('connection', (ws) => ws.on('message', (data) => ws.send(`echo:${String(data)}`)));
  ports.a = await listen(sa, 'localhost');
  ports.b = await listen(sb, '127.0.0.1');
  return {
    a: `http://localhost:${ports.a}`,
    b: `http://127.0.0.1:${ports.b}`,
    portA: ports.a,
    portB: ports.b,
    requests,
    close: async () => {
      sa.closeAllConnections();
      sb.closeAllConnections();
      await Promise.all([new Promise((r) => sa.close(r)), new Promise((r) => sb.close(r))]);
    },
  };
}

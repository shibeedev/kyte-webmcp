/** Unit tests for how a bridge picks the Chrome profile it serves (real WebSocket, no browser). */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { acceptsProfile, ExtensionHub, type HubOptions } from '../../src/bridge/hub.ts';
import { EXTENSION_ORIGIN, PROTOCOL_VERSION, WS_PATH } from '../../src/shared/constants.ts';
import { CLOSE_OTHER_PROFILE, CLOSE_RELEASE, type ProfileInfo } from '../../src/shared/protocol.ts';

const work: ProfileInfo = { id: 'id-work', name: 'Work' };
const home: ProfileInfo = { id: 'id-home', name: 'Home' };

describe('profile rule', () => {
  it('pinned by name accepts only that name (case and spaces ignored)', () => {
    assert.equal(acceptsProfile({ profile: 'work ' }, null, work), true);
    assert.equal(acceptsProfile({ profile: 'Work' }, null, home), false);
    assert.equal(acceptsProfile({ profile: 'Work' }, null, undefined), false);
  });
  it('pinned by id (LAN host) accepts only that profile', () => {
    assert.equal(acceptsProfile({ profileId: 'id-home' }, null, home), true);
    assert.equal(acceptsProfile({ profileId: 'id-home' }, null, { id: 'id-other', name: 'Home' }), false);
  });
  it('unpinned accepts anyone until bound, then only the bound profile', () => {
    assert.equal(acceptsProfile({}, null, home), true);
    assert.equal(acceptsProfile({}, 'id-work', work), true);
    assert.equal(acceptsProfile({}, 'id-work', home), false);
  });
});

/** Connects like one Chrome profile's extension: resolves "welcome" or "closed <code>". */
function connect(port: number, profile: ProfileInfo, opts: { keep?: WebSocket[] } = {}): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: EXTENSION_ORIGIN });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, extVersion: 't', userAgent: 'ua', profile })));
    ws.on('message', (data) => {
      if (JSON.parse(String(data)).t === 'welcome') {
        opts.keep?.push(ws);
        resolve('welcome');
      }
    });
    ws.on('close', (code) => resolve(`closed ${code}`));
  });
}

const closed = (ws: WebSocket, code?: number) => new Promise<void>((resolve) => (ws.once('close', () => resolve()), code ? ws.close(code) : ws.close()));

describe('bridge serving one Chrome profile', () => {
  let hub: ExtensionHub | null = null;
  const start = async (options: HubOptions) => {
    hub = new ExtensionHub('test', {}, '', options);
    // A random free port outside the shared range, so the test never meets a real extension.
    return await hub.listen(await freePort());
  };
  afterEach(async () => {
    await hub?.close();
    hub = null;
  });

  it('pinned with --profile: another profile never gets a session, even when it comes first', async () => {
    const port = await start({ profile: 'Work' });
    const open: WebSocket[] = [];
    assert.equal(await connect(port, home), `closed ${CLOSE_OTHER_PROFILE}`);
    assert.equal(hub!.isConnected(), false);
    assert.equal(await connect(port, work, { keep: open }), 'welcome');
    assert.match(hub!.profileStatus(), /"Work" \(pinned with --profile\)/);
    await closed(open[0]!);
  });

  it('unpinned: stays with the first profile across reconnects', async () => {
    const port = await start({});
    const open: WebSocket[] = [];
    assert.equal(await connect(port, work, { keep: open }), 'welcome');
    await closed(open.pop()!); // e.g. Chrome stopped the idle service worker
    await waitUntil(() => !hub!.isConnected());
    assert.equal(await connect(port, home), `closed ${CLOSE_OTHER_PROFILE}`);
    assert.equal(await connect(port, work, { keep: open }), 'welcome');
    assert.match(hub!.profileStatus(), /"Work" \(the first profile that connected/);
    await closed(open.pop()!);
  });

  it('unpinned: moves to another profile only when the bound one releases it', async () => {
    const port = await start({});
    const open: WebSocket[] = [];
    assert.equal(await connect(port, work, { keep: open }), 'welcome');
    await closed(open.pop()!, CLOSE_RELEASE); // Work turned its connections off
    await waitUntil(() => !hub!.isConnected());
    assert.equal(await connect(port, home, { keep: open }), 'welcome');
    assert.match(hub!.notConnectedHelp(), /Home/);
    await closed(open.pop()!);
  });

  it('pinned with --profile ignores a release', async () => {
    const port = await start({ profile: 'Work' });
    const open: WebSocket[] = [];
    assert.equal(await connect(port, work, { keep: open }), 'welcome');
    await closed(open.pop()!, CLOSE_RELEASE);
    await waitUntil(() => !hub!.isConnected());
    assert.equal(await connect(port, home), `closed ${CLOSE_OTHER_PROFILE}`);
  });

  it('LAN bridge accepts only the profile that started the LAN host', async () => {
    const port = await start({ profileId: 'id-home', remote: '192.168.0.9' });
    const open: WebSocket[] = [];
    assert.equal(await connect(port, { id: 'id-other', name: 'Home' }), `closed ${CLOSE_OTHER_PROFILE}`);
    assert.equal(await connect(port, home, { keep: open }), 'welcome');
    await closed(open.pop()!);
  });
});

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function waitUntil(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

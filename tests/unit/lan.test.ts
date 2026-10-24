/** Unit tests for the LAN endpoint: address filter, native messaging framing and HTTP access control (no browser). */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, LanGateway, normalizeAddress } from '../../src/bridge/lan.ts';
import { encodeNative, NativeReader } from '../../src/bridge/native-host.ts';
import { LAN_PATH } from '../../src/shared/constants.ts';

describe('LAN address filter', () => {
  it('accepts loopback, private and link-local addresses', () => {
    for (const a of ['192.168.0.20', '10.1.2.3', '172.16.0.1', '172.31.255.254', '127.0.0.1', '169.254.10.1', '::ffff:192.168.1.2', '::1', 'fd12:3456::1', 'fc00::5', 'fe80::1', 'FE80::abcd']) assert.equal(isPrivateAddress(a), true, a);
  });
  it('rejects public and carrier-grade NAT addresses', () => {
    for (const a of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.64.1.1', '193.168.0.1', '2001:db8::1', '::ffff:8.8.8.8', 'fd1::1', '']) assert.equal(isPrivateAddress(a), false, a);
  });
  it('unwraps IPv4-mapped IPv6 addresses', () => {
    assert.equal(normalizeAddress('::ffff:192.168.0.9'), '192.168.0.9');
    assert.equal(normalizeAddress('fe80::1'), 'fe80::1');
  });
});

describe('native messaging framing', () => {
  it('round-trips messages split across chunks and packed into one chunk', () => {
    const got: unknown[] = [];
    const reader = new NativeReader((m) => got.push(m));
    const a = encodeNative({ t: 'start', token: 'tök€n' });
    const b = encodeNative({ t: 'scan' });
    assert.equal(a.readUInt32LE(0), a.length - 4);
    reader.push(a.subarray(0, 2));
    reader.push(a.subarray(2, 9));
    assert.equal(got.length, 0);
    reader.push(Buffer.concat([a.subarray(9), b]));
    assert.deepEqual(got, [{ t: 'start', token: 'tök€n' }, { t: 'scan' }]);
  });
  it('skips malformed messages and keeps reading', () => {
    const got: unknown[] = [];
    const reader = new NativeReader((m) => got.push(m));
    const bad = Buffer.from('{oops');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bad.length);
    reader.push(Buffer.concat([header, bad, encodeNative({ ok: 1 })]));
    assert.deepEqual(got, [{ ok: 1 }]);
  });
});

describe('LAN endpoint access control', () => {
  const token = 'unit-test-token';
  let gateway: LanGateway;
  let url: string;
  const created: string[] = [];

  before(async () => {
    // Every request below is refused before a bridge would be created.
    gateway = new LanGateway((remote) => {
      created.push(remote);
      throw new Error('no bridge in unit tests');
    }, () => {});
    await gateway.setToken(token);
    await gateway.listen(0);
    url = `http://127.0.0.1:${gateway.port}${LAN_PATH}`;
  });
  after(() => gateway.close());

  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const post = (headers: Record<string, string>, body = initialize, target = url) =>
    fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body });

  it('needs the access token', async () => {
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post({ authorization: token })).status, 401);
    const res = await post({ authorization: 'Bearer nope' });
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /access token/);
  });
  it('refuses requests from web pages (Origin header), even with the token', async () => {
    assert.equal((await post({ authorization: `Bearer ${token}`, origin: 'http://192.168.0.50' })).status, 403);
  });
  it('serves only the MCP path', async () => {
    assert.equal((await post({ authorization: `Bearer ${token}` }, initialize, url.replace(LAN_PATH, '/other'))).status, 404);
  });
  it('rejects unknown sessions and non-initialize requests without a session', async () => {
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await post({ ...auth, 'mcp-session-id': 'not-a-session' }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).status, 404);
    assert.equal((await post(auth, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).status, 400);
    assert.equal((await post(auth, '{not json')).status, 400);
    assert.deepEqual(created, []);
  });
  it('a new token replaces the old one', async () => {
    await gateway.setToken('second-token');
    assert.equal((await post({ authorization: `Bearer ${token}`, 'mcp-session-id': 'x' })).status, 401);
    assert.equal((await post({ authorization: 'Bearer second-token', 'mcp-session-id': 'x' })).status, 404);
  });
});

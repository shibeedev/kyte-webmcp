/** Video understanding: listing, control, frames, storyboards, captions, local Whisper transcription, watch, media details. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { EXTENSION_ID } from '../../src/shared/constants.ts';
import { startFixtureServers, type FixtureServers } from '../helpers/server.ts';
import { call, launchBrowser, ok, sleep, startClient, waitConnected, type BrowserHandle, type McpHandle } from '../helpers/harness.ts';

const PORT = 17837;
let srv: FixtureServers;
let bh: BrowserHandle;
let mcp: McpHandle;
let v1 = '';
let v2 = '';

/** Background colour of a scene frame, sampled in the top-left corner (away from the burned-in text). */
async function sceneColor(b64: string): Promise<string> {
  const img = sharp(Buffer.from(b64, 'base64'));
  const { width = 0, height = 0 } = await img.metadata();
  // stats() reads the input image, so cut the corner out into its own buffer first.
  const corner = await img.extract({ left: Math.round(width * 0.03), top: Math.round(height * 0.05), width: Math.max(4, Math.round(width * 0.1)), height: Math.max(4, Math.round(height * 0.1)) }).png().toBuffer();
  const region = await sharp(corner).stats();
  const [r, g, b] = region.channels.map((c) => c.mean) as [number, number, number];
  // Ratios rather than absolute levels: lossy encodes and screen capture shift the brightness.
  if (r > 2 * g && r > 2 * b) return 'red';
  if (g > 1.5 * r && g > 1.3 * b) return 'green';
  if (b > 1.5 * r && b > 1.5 * g && r < 0.6 * b) return 'blue';
  if (r > 1.5 * g && b > 2 * g) return 'purple';
  return `other(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

async function state(ref: string) {
  const r = await ok(mcp.client, 'evaluate', { function: `() => { const v = [...document.querySelectorAll('video')].find((x, i) => i === ${ref === v1 ? 0 : 1}); return [Math.round(v.currentTime * 10) / 10, v.paused]; }` });
  return r.text.replace(/\s+/g, '');
}

describe('video understanding', () => {
  before(async () => {
    srv = await startFixtureServers();
    // Like a real profile: unmuted playback needs a user gesture.
    bh = await launchBrowser({ args: ['--autoplay-policy=user-gesture-required'] });
    mcp = await startClient(PORT);
    await waitConnected(mcp.client);
    await ok(mcp.client, 'tab_open', { url: `${srv.a}/video.html` });
    await ok(mcp.client, 'wait_for', { timeMs: 800 });
  });
  after(async () => {
    await mcp?.close();
    await bh?.close();
    await srv?.close();
  });

  it('lists media with details and picks the main video', async () => {
    const r = await ok(mcp.client, 'video_list');
    assert.match(r.text, /2 media elements \(main: \[e\d+\]\)/);
    assert.match(r.text, /video 640×360 · 0:20\.0 · at 0:00\.0 · paused/);
    assert.match(r.text, /captions: en/);
    assert.match(r.text, /label "Scene demo"/);
    v1 = r.text.match(/\[(e\d+)\] video 640×360/)![1]!;
    v2 = [...r.text.matchAll(/\[(e\d+)\] video/g)].map((m) => m[1]!).find((x) => x !== v1)!;
    assert.match(r.text, new RegExp(`main: \\[${v1}\\]`));
  });

  it('controls playback', async () => {
    assert.match((await ok(mcp.client, 'video_control', { action: 'play', video: v1 })).text, /playing/);
    await ok(mcp.client, 'video_control', { action: 'pause', video: v1 });
    assert.match((await ok(mcp.client, 'video_control', { action: 'seek', video: v1, time: 7 })).text, /at 7\.00s · position 0:07\.0/);
    assert.match((await ok(mcp.client, 'video_control', { action: 'rate', video: v1, rate: 1.5 })).text, /rate 1\.5/);
    assert.match((await ok(mcp.client, 'video_control', { action: 'mute', video: v1 })).text, /muted/);
    assert.match((await ok(mcp.client, 'video_control', { action: 'volume', video: v1, volume: 0.5 })).text, /volume 0\.5/);
    await ok(mcp.client, 'video_control', { action: 'rate', video: v1, rate: 1 });
  });

  it('captures frames at timestamps and restores the playback state', async () => {
    await ok(mcp.client, 'video_control', { action: 'seek', video: v1, time: 3.3 });
    const before = await state(v1);
    const r = await ok(mcp.client, 'video_frame', { video: v1, times: [2, 7, 12, 17] });
    assert.equal(r.images.length, 4);
    const colors = await Promise.all(r.images.map((i) => sceneColor(i.data)));
    assert.deepEqual(colors, ['red', 'green', 'blue', 'purple']);
    assert.equal(await state(v1), before, 'position and paused state restored');
    const current = await ok(mcp.client, 'video_frame', { video: v1 });
    assert.equal(current.images.length, 1);
    assert.equal(await sceneColor(current.images[0]!.data), 'red');
  });

  it('captures cross-origin video frames from the screen', async () => {
    const r = await ok(mcp.client, 'video_frame', { video: v2, times: [12] });
    assert.match(r.text, /Captured from the screen/);
    assert.equal(r.images.length, 1);
    assert.equal(await sceneColor(r.images[0]!.data), 'blue');
  });

  it('builds a storyboard grid', async () => {
    const r = await ok(mcp.client, 'video_storyboard', { video: v1, count: 8 });
    assert.match(r.text, /8 frames \(0:01\.[23] – 0:18\.8, decoded frames\)/);
    assert.equal(r.images.length, 1);
    const meta = await sharp(Buffer.from(r.images[0]!.data, 'base64')).metadata();
    assert.equal(meta.width, 4 * 320 + 5 * 4);
    assert.equal(meta.height, 2 * 180 + 3 * 4);
  });

  it('reads captions from the HTML5 track', async () => {
    const r = await ok(mcp.client, 'video_captions', { video: v1 });
    assert.match(r.text, /HTML5 caption track "English" \(en\)/);
    assert.match(r.text, /4 cues/);
    assert.match(r.text, /\[0:05\.1 → 0:08\.0\] Scene two shows a green background\./);
    const none = await call(mcp.client, 'video_captions', { video: v2 });
    assert.ok(none.isError);
    assert.match(none.text, /has no captions[\s\S]*video_transcribe/);
  });

  it('transcribes speech locally with Whisper (decoded file)', async () => {
    const r = await ok(mcp.client, 'video_transcribe', { video: v1, start: 0, duration: 20, language: 'en' }, 600_000);
    assert.match(r.text, /local Whisper base/);
    assert.match(r.text, /audio from decoded media file/);
    const text = r.text.toLowerCase();
    assert.match(text, /welcome/);
    assert.match(text, /green/);
    assert.match(text, /blue/);
    assert.match(text, /thanks for watching/);
    assert.match(r.text, /\[0:0\d\.\d → /);
  });

  it('transcribes in real time from the playing element and restores state', async () => {
    await ok(mcp.client, 'video_control', { action: 'seek', video: v1, time: 1 });
    const before = await state(v1);
    const r = await ok(mcp.client, 'video_transcribe', { video: v1, start: 5, duration: 4, source: 'stream', language: 'en' }, 120_000);
    assert.match(r.text, /real-time capture while playing/);
    assert.match(r.text.toLowerCase(), /green/);
    assert.equal(await state(v1), before);
  });

  it('transcribes a cross-origin video by decoding it through the extension', async () => {
    const r = await ok(mcp.client, 'video_transcribe', { video: v2, start: 10, duration: 5, language: 'en' }, 120_000);
    assert.match(r.text, /decoded media file/);
    assert.match(r.text.toLowerCase(), /blue/);
  });

  it('reports silence instead of an empty transcript', async () => {
    // 3.6 s – 4.9 s of the sample is the pause between the first two sentences.
    const r = await call(mcp.client, 'video_transcribe', { video: v1, start: 3.6, duration: 1.3, source: 'decode' }, 120_000);
    assert.ok(r.isError, r.text);
    assert.match(r.text, /The captured audio is silent/);
  });

  it('explains why a cross-origin element cannot be captured live', async () => {
    const r = await call(mcp.client, 'video_transcribe', { video: v2, start: 2, duration: 2, source: 'stream' }, 120_000);
    assert.ok(r.isError, r.text);
    assert.match(r.text, /cross-origin without CORS[\s\S]*source="decode"/);
  });

  it('watches a segment: storyboard plus captions', async () => {
    const r = await ok(mcp.client, 'video_watch', { video: v1, start: 0, duration: 20, frames: 6 }, 300_000);
    assert.equal(r.images.length, 1);
    assert.match(r.text, /Watched 0:00\.0 – 0:20\.0/);
    assert.match(r.text, /Speech \(from HTML5 caption track "English", en\)/);
    assert.match(r.text, /Thanks for watching this demo\./);
  });

  it('watches a video without captions using Whisper', async () => {
    const r = await ok(mcp.client, 'video_watch', { video: v2, start: 0, duration: 8, frames: 4, language: 'en' }, 300_000);
    assert.match(r.text, /Speech \(local Whisper transcription, audio from decoded media file\)/);
    assert.match(r.text.toLowerCase(), /welcome/);
  });

  it('inspects the media player', async () => {
    await ok(mcp.client, 'video_control', { action: 'play', video: v1 });
    const r = await ok(mcp.client, 'media_inspect', { video: v1, sampleMs: 1200 });
    assert.match(r.text, /readyState 4 \(HAVE_ENOUGH_DATA\)/);
    assert.match(r.text, /2\d(\.\d)? fps measured/);
    assert.match(r.text, /Codec and decoder details \(DevTools Media panel\) need the full DevTools channel/);
    await ok(mcp.client, 'video_control', { action: 'pause', video: v1 });
  });

  it('plays even when the page only allows playback after a user gesture', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/autoplay.html` });
    await ok(mcp.client, 'wait_for', { text: 'NotAllowedError', timeoutMs: 10_000 }); // the page's own play() was refused
    const r = await ok(mcp.client, 'video_control', { action: 'play' });
    assert.doesNotMatch(r.text, /blocked/i);
    await sleep(700);
    const playing = await ok(mcp.client, 'evaluate', { expression: '[v4.paused, v4.currentTime > 0.2]' });
    assert.match(playing.text.replace(/\s+/g, ''), /\[false,true\]/);
    await ok(mcp.client, 'video_control', { action: 'pause' });
  });

  it('reads encrypted (DRM) videos from the screen and reports frames DRM keeps black', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/drm.html` });
    await ok(mcp.client, 'wait_for', { text: 'ready', timeoutMs: 10_000 });
    const list = await ok(mcp.client, 'video_list');
    assert.equal((list.text.match(/DRM-protected/g) ?? []).length, 2, list.text);
    const [black, red] = [...list.text.matchAll(/\[(e\d+)\] video/g)].map((m) => m[1]!);
    const blocked = await ok(mcp.client, 'video_frame', { video: black });
    assert.equal(blocked.images.length, 0, 'no black image passed off as a frame');
    assert.match(blocked.text, /blocked by DRM/);
    // Chrome never lets a canvas read encrypted frames, but this Clear Key video is visible on screen.
    const visible = await ok(mcp.client, 'video_frame', { video: red });
    assert.equal(visible.images.length, 1);
    assert.match(visible.text, /Captured from the screen \(encrypted frames cannot be read directly\)/);
    assert.equal(await sceneColor(visible.images[0]!.data), 'red');
  });

  it('tries every audio source in auto mode, then explains how to allow tab capture', async () => {
    await ok(mcp.client, 'navigate', { url: `${srv.a}/video-protected.html` });
    await ok(mcp.client, 'wait_for', { timeMs: 800 });
    const r = await call(mcp.client, 'video_transcribe', { start: 1, duration: 2 }, 120_000);
    assert.ok(r.isError, r.text);
    assert.match(r.text, /decoded media file failed: .*HTTP 403/);
    assert.match(r.text, /real-time capture while playing failed: .*cross-origin without CORS/);
    assert.match(r.text, /tab audio capture failed: Tab audio capture is not permitted .*click the Neo WebMCP toolbar icon/);
  });
});

describe('tab audio capture', () => {
  let srv2: FixtureServers;
  let bh2: BrowserHandle;
  let mcp2: McpHandle;
  const position = async () => (await ok(mcp2.client, 'evaluate', { expression: '[Math.round(v3.currentTime * 10) / 10, v3.paused]' })).text.replace(/\s+/g, '');

  before(async () => {
    srv2 = await startFixtureServers();
    // Chromium's allowlist switch stands in for the user's click on the extension icon, which tab capture requires.
    // The tab must not be muted (capture would be silent), and a fake audio output keeps the speakers quiet.
    bh2 = await launchBrowser({ unmuted: true, args: ['--autoplay-policy=user-gesture-required', `--allowlisted-extension-id=${EXTENSION_ID}`, '--disable-audio-output'] });
    mcp2 = await startClient(17835);
    await waitConnected(mcp2.client);
    await ok(mcp2.client, 'tab_open', { url: `${srv2.a}/video-protected.html` });
    await ok(mcp2.client, 'wait_for', { timeMs: 800 });
  });
  after(async () => {
    await mcp2?.close();
    await bh2?.close();
    await srv2?.close();
  });

  it('falls back to recording the tab when nothing else can capture the audio', async () => {
    const before = await position();
    const r = await ok(mcp2.client, 'video_transcribe', { start: 0, duration: 8, language: 'en' }, 180_000);
    assert.match(r.text, /audio from tab audio capture \(decoded media file failed: .*HTTP 403; real-time capture while playing failed: .*cross-origin/);
    assert.match(r.text.toLowerCase(), /welcome/);
    assert.equal(await position(), before, 'playback position and state restored');
  });
});

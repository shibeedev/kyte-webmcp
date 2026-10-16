import type { Core } from '../../extension/background/core.ts';
import { nodeBox } from '../../extension/background/geometry.ts';
import { compositeGrid, meanLuminance, scaleImage } from '../../extension/background/image.ts';
import type { RefEntry } from '../../extension/background/refs.ts';
import type { CallContext, Feature } from '../../extension/background/types.ts';
import type { ToolContent } from '../../shared/protocol.ts';
import { ToolError, errorMessage, formatSeconds, imageContent, sleep, withTimeout } from '../../extension/background/util.ts';
import { looksLikeCaptionUrl, parseCaptions, parseYoutubeJson3, type Cue } from './captions.ts';
import {
  controlMedia,
  findMediaElements,
  grabFrame,
  mediaInfo,
  playbackState,
  readTextTracks,
  restoreState,
  sampleMedia,
  seekTo,
  startAudioCapture,
  stopAudioCapture,
  youtubeCaptionTracks,
  youtubeEnableCaptions,
} from './page.ts';
import { DEFAULT_WATCH_SECONDS } from './spec.ts';

type MediaInfo = ReturnType<typeof mediaInfo>;
interface Media {
  entry: RefEntry;
  info: MediaInfo;
}

/** Readable summary of DevTools Media-panel player properties (codecs, decoders, tracks). */
export function mediaPanelSummary(props: Record<string, string>): string {
  const parse = (v?: string) => {
    try {
      return v ? (JSON.parse(v) as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  };
  const parts: string[] = [];
  for (const t of parse(props.kVideoTracks)) {
    const size = t['coded size'] ?? t['natural size'];
    parts.push(`video ${t.codec ?? '?'}${t.profile ? ` (${t.profile})` : ''}${size ? ` ${String(size).replace(/[[\]\s]/g, '').replace(',', '×')}` : ''}`);
  }
  if (props.kVideoDecoderName) parts.push(`video decoder ${props.kVideoDecoderName}${props.kIsPlatformVideoDecoder === 'true' ? ' (hardware)' : ''}`);
  for (const t of parse(props.kAudioTracks)) parts.push(`audio ${t.codec ?? '?'} ${String(t['channel layout'] ?? '').toLowerCase()} ${t['samples per second'] ?? ''} Hz`.replace(/\s+/g, ' ').trim());
  if (props.kAudioDecoderName) parts.push(`audio decoder ${props.kAudioDecoderName}`);
  const skip = new Set(['kVideoTracks', 'kAudioTracks', 'kVideoDecoderName', 'kAudioDecoderName', 'kIsPlatformVideoDecoder', 'kFrameUrl', 'kFrameTitle']);
  const rest = Object.entries(props).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k.replace(/^k/, '')}=${String(v).slice(0, 80)}`);
  return [...parts, ...rest].join(' · ');
}

const READY = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
const NETWORK = ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'];

// ---- network observations kept by this feature (captions files, media bytes) ----
interface CaptionResponse {
  requestId: string;
  sessionId?: string;
  url: string;
  mime: string;
  finished: boolean;
  at: number;
}
const captionResponses = new Map<number, CaptionResponse[]>();
const mediaRequests = new Map<string, { tabId: number; mime: string; url: string }>();
const mediaBytes = new Map<number, Array<{ at: number; bytes: number }>>();

function platformOf(url: string | undefined): string {
  const host = url ? new URL(url).hostname : '';
  const known: Array<[RegExp, string]> = [
    [/(^|\.)youtube\.com$|(^|\.)youtu\.be$|youtube-nocookie\.com$/, 'YouTube'],
    [/vimeo\.com$/, 'Vimeo'],
    [/twitch\.tv$/, 'Twitch'],
    [/tiktok\.com$/, 'TikTok'],
    [/facebook\.com$|fb\.watch$/, 'Facebook'],
    [/instagram\.com$/, 'Instagram'],
    [/(^|\.)x\.com$|twitter\.com$/, 'X'],
    [/netflix\.com$/, 'Netflix'],
    [/dailymotion\.com$/, 'Dailymotion'],
    [/bilibili\.com$/, 'Bilibili'],
  ];
  return known.find(([re]) => re.test(host))?.[1] ?? 'HTML5';
}

function describe(m: Media, platform: string): string {
  const i = m.info;
  const dur = i.duration === -1 ? 'live' : i.duration === null ? 'unknown length' : formatSeconds(i.duration);
  const caps = i.tracks.filter((t) => ['captions', 'subtitles', ''].includes(t.kind));
  return [
    `[${m.entry.ref}] ${i.tag}${i.width ? ` ${i.width}×${i.height}` : ''} · ${dur} · at ${formatSeconds(i.currentTime)} · ${i.ended ? 'ended' : i.paused ? 'paused' : 'playing'}${i.muted ? ' · muted' : ''}${i.playbackRate !== 1 ? ` · rate ${i.playbackRate}` : ''}`,
    `    source: ${i.blob ? 'MediaSource stream (blob)' : i.src || '(none)'} · platform ${platform}${i.drm ? ' · DRM-protected' : ''}${m.entry.sessionId ? ' · inside an iframe' : ''}${i.visibleArea > 0 ? ' · visible' : ' · not in view'}`,
    `    captions: ${caps.length ? caps.map((t) => `${t.language || t.label || t.kind}${t.mode === 'showing' ? ' (showing)' : ''}`).join(', ') : 'no HTML5 tracks'}${i.label ? ` · label "${i.label}"` : ''}${i.error ? ` · ERROR ${i.error.code} ${i.error.message}` : ''}`,
  ].join('\n');
}

async function listMedia(core: Core, tabId: number): Promise<Media[]> {
  await core.cdp.ensure(tabId);
  const sessions: Array<string | undefined> = [undefined, ...core.cdp.children(tabId).filter((c) => c.type === 'iframe').map((c) => c.sessionId)];
  const out: Media[] = [];
  for (const sessionId of sessions) {
    try {
      const nodes = await withTimeout(core.page.elementsFrom(tabId, findMediaElements, [], { sessionId }), 8000, 'media search timed out');
      for (const n of nodes) {
        const entry = core.refs.register({ tabId, sessionId, frameId: n.frameId, backendNodeId: n.backendNodeId });
        const info = await core.page.callOn<MediaInfo>(entry, mediaInfo);
        entry.role = info.tag;
        entry.name = info.label || undefined;
        out.push({ entry, info });
      }
    } catch (error) {
      if (!sessionId) throw error;
    }
  }
  return out;
}

function pickMain(list: Media[]): Media | undefined {
  const videos = list.filter((m) => m.info.tag === 'video');
  const pool = videos.length ? videos : list;
  const score = (m: Media) => (!m.info.paused ? 1e12 : 0) + m.info.visibleArea * 10 + (m.info.width * m.info.height > 0 ? 1e6 : 0) + (m.info.duration ? 1 : 0);
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

async function resolveMedia(core: Core, tabId: number, ref?: string): Promise<Media> {
  await core.cdp.ensure(tabId);
  if (ref) {
    const entry = core.refs.get(tabId, ref);
    const tag = await core.page.callOn<string>(entry, function (this: Element) {
      return this.tagName.toLowerCase();
    });
    if (tag !== 'video' && tag !== 'audio') throw new ToolError(`[${entry.ref}] is a <${tag}>, not a video or audio element. Use video_list to find media refs.`);
    return { entry, info: await core.page.callOn<MediaInfo>(entry, mediaInfo) };
  }
  const main = pickMain(await listMedia(core, tabId));
  if (!main) throw new ToolError('There is no video or audio element on this page (including iframes and shadow DOM).');
  return main;
}

interface Frame {
  data: string;
  time: number;
  method: 'canvas' | 'screen';
  drmBlack: boolean;
}

async function captureFrame(core: Core, tabId: number, media: Media, maxWidth: number, at?: number): Promise<Frame> {
  if (at !== undefined) await core.page.callOn(media.entry, seekTo, [at]);
  const grabbed = await core.page.callOn<ReturnType<typeof grabFrame>>(media.entry, grabFrame, [maxWidth, 0.85]);
  if (!('error' in grabbed) || !grabbed.error) {
    const ok = grabbed as { data: string; time: number };
    // Chrome never lets a canvas read encrypted (EME) frames, so black here proves nothing: the screen may still show the picture.
    if (!media.info.drm || (await meanLuminance(ok.data, 'image/jpeg')) >= 6) return { data: ok.data, time: ok.time, method: 'canvas', drmBlack: false };
    return captureFromScreen(core, tabId, media, maxWidth, ok.time);
  }
  if (grabbed.error === 'no-frame') throw new ToolError('The video has no decoded frame yet (it may still be loading). Play it briefly or wait, then try again.');
  // Cross-origin media taints the canvas: capture the element from the screen instead.
  return captureFromScreen(core, tabId, media, maxWidth, grabbed.time);
}

async function captureFromScreen(core: Core, tabId: number, media: Media, maxWidth: number, time: number): Promise<Frame> {
  const scroll = await core.page.evaluate<{ x: number; y: number }>(tabId, () => ({ x: scrollX, y: scrollY }));
  try {
    await core.cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: media.entry.backendNodeId }, media.entry.sessionId).catch(() => {});
    const box = await nodeBox(core.cdp, media.entry);
    if (!box) throw new ToolError('The video element is not rendered, so its frame cannot be captured from the screen.');
    const { cssVisualViewport: vv } = await core.cdp.send(tabId, 'Page.getLayoutMetrics');
    const shot = await core.overlay.withHidden(tabId, () =>
      core.cdp.send(tabId, 'Page.captureScreenshot', { format: 'png', clip: { x: box.x + vv.pageX, y: box.y + vv.pageY, width: box.width, height: box.height, scale: 1 }, captureBeyondViewport: true }),
    );
    const scaled = await scaleImage(shot.data, 'image/png', maxWidth, 'jpeg', 85);
    const lum = await meanLuminance(scaled.data, scaled.mimeType);
    return { data: scaled.data, time, method: 'screen', drmBlack: lum < 6 && media.info.drm };
  } finally {
    await core.page.evaluate(tabId, (x: number, y: number) => window.scrollTo(x, y), [scroll.x, scroll.y]).catch(() => {});
  }
}

/** Runs `work` with playback paused and restores position, rate and play/pause state afterwards (BRD 2.2.8). */
async function preservingPlayback<T>(core: Core, media: Media, work: () => Promise<T>): Promise<T> {
  const state = await core.page.callOn<ReturnType<typeof playbackState>>(media.entry, playbackState);
  await core.page.callOn(media.entry, controlMedia, ['pause']);
  try {
    return await work();
  } finally {
    await core.page.callOn(media.entry, restoreState, [state], { userGesture: true }).catch(() => {});
  }
}

/** Grid columns with the fewest empty cells and an overall shape close to 2:1 (16:9 tiles). */
export function gridColumns(count: number): number {
  let best = 1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let cols = 1; cols <= Math.min(8, count); cols++) {
    const rows = Math.ceil(count / cols);
    const aspect = (cols * 16) / (rows * 9);
    const cost = (rows * cols - count) + Math.abs(Math.log(aspect / 2));
    if (cost < bestCost) {
      bestCost = cost;
      best = cols;
    }
  }
  return best;
}

function frameTimes(start: number, end: number, count: number): number[] {
  const step = (end - start) / count;
  return Array.from({ length: count }, (_, i) => Math.round((start + step * (i + 0.5)) * 100) / 100);
}

async function storyboard(core: Core, tabId: number, media: Media, opts: { start?: number; end?: number; count: number; columns?: number; tileWidth: number; signal: AbortSignal }): Promise<{ image: { data: string; mimeType: string; width: number; height: number }; times: number[]; live: boolean; method: string; drm: boolean }> {
  const i = media.info;
  const live = i.duration === -1 || i.duration === null || !i.seekable.length;
  const columns = opts.columns ?? gridColumns(opts.count);
  const frames: Frame[] = [];
  if (!live) {
    const start = Math.max(0, Math.min(opts.start ?? 0, i.duration! - 0.05));
    const end = Math.max(start + 0.1, Math.min(opts.end ?? i.duration!, i.duration!));
    await preservingPlayback(core, media, async () => {
      for (const t of frameTimes(start, end, opts.count)) {
        if (opts.signal.aborted) throw new ToolError('Cancelled');
        frames.push(await captureFrame(core, tabId, media, opts.tileWidth, t));
      }
    });
  } else {
    // Live or non-seekable: sample while it plays.
    const span = Math.max(1, (opts.end ?? 0) - (opts.start ?? 0)) || opts.count * 2;
    const interval = (span / opts.count) * 1000;
    const state = await core.page.callOn<ReturnType<typeof playbackState>>(media.entry, playbackState);
    if (state.paused) await core.page.callOn(media.entry, controlMedia, ['play'], { userGesture: true });
    try {
      for (let n = 0; n < opts.count; n++) {
        frames.push(await captureFrame(core, tabId, media, opts.tileWidth));
        if (n < opts.count - 1) await sleep(interval, opts.signal);
      }
    } finally {
      if (state.paused) await core.page.callOn(media.entry, controlMedia, ['pause']).catch(() => {});
    }
  }
  const image = await compositeGrid(frames.map((f) => ({ data: f.data, mimeType: 'image/jpeg', caption: formatSeconds(f.time) })), columns, opts.tileWidth, 'jpeg', 80);
  return { image, times: frames.map((f) => f.time), live, method: frames.some((f) => f.method === 'screen') ? 'screen capture' : 'decoded frames', drm: frames.some((f) => f.drmBlack) };
}

// ---- captions ----

interface CaptionResult {
  source: string;
  language?: string;
  cues: Cue[];
  available?: string[];
}

async function networkBody(core: Core, tabId: number, r: CaptionResponse): Promise<string | null> {
  try {
    const res = await core.cdp.send(tabId, 'Network.getResponseBody', { requestId: r.requestId }, r.sessionId);
    return res.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0))) : res.body;
  } catch {
    return null;
  }
}

async function getCaptions(core: Core, tabId: number, media: Media, lang: string | null, signal: AbortSignal): Promise<CaptionResult | null> {
  const tracks = await core.page.callOn<Awaited<ReturnType<typeof readTextTracks>>>(media.entry, readTextTracks, [lang]);
  if (tracks?.cues.length) return { source: `HTML5 caption track "${tracks.label || tracks.language || tracks.kind}"`, language: tracks.language, cues: tracks.cues, available: tracks.available };
  const tab = await chrome.tabs.get(tabId);
  const frameUrl = media.entry.sessionId ? core.cdp.child(tabId, media.entry.sessionId)?.url : tab.url;
  if (platformOf(frameUrl) === 'YouTube') {
    const yt = await core.page.evaluate<Awaited<ReturnType<typeof youtubeCaptionTracks>>>(tabId, youtubeCaptionTracks, [lang], { world: 'main', sessionId: media.entry.sessionId }).catch(() => null);
    if (yt?.body) {
      const cues = parseYoutubeJson3(yt.body);
      if (cues.length) return { source: 'YouTube captions', language: yt.picked, cues, available: yt.tracks.map((t) => `${t.language}${t.kind === 'asr' ? ' (auto)' : ''}`) };
    }
    if (yt?.tracks.length) {
      // The direct URL needs a player token: let the player fetch them and read the response.
      const since = Date.now();
      await core.page.evaluate(tabId, youtubeEnableCaptions, [lang ?? yt.picked ?? null], { world: 'main', sessionId: media.entry.sessionId, userGesture: true }).catch(() => false);
      for (let i = 0; i < 40 && !signal.aborted; i++) {
        const hit = (captionResponses.get(tabId) ?? []).filter((r) => r.at >= since && r.finished && /timedtext/.test(r.url)).at(-1);
        if (hit) {
          const body = await networkBody(core, tabId, hit);
          const cues = body ? parseCaptions(body, hit.url, hit.mime) : [];
          if (cues.length) return { source: 'YouTube captions (fetched by the player)', language: yt.picked, cues, available: yt.tracks.map((t) => t.language) };
        }
        await sleep(200, signal);
      }
    }
  }
  // Caption files from the network log are not tied to an element: skip the ones that belong to
  // another media element's <track>, so one video never gets another video's captions.
  const ownedByTracks = new Set(
    await core.page
      .evaluate<string[]>(tabId, () => Array.from(document.querySelectorAll('track')).map((t) => (t as HTMLTrackElement).src), [], { sessionId: media.entry.sessionId })
      .catch(() => [] as string[]),
  );
  for (const r of [...(captionResponses.get(tabId) ?? [])].reverse()) {
    if (!r.finished || ownedByTracks.has(r.url)) continue;
    const body = await networkBody(core, tabId, r);
    const cues = body ? parseCaptions(body, r.url, r.mime) : [];
    if (cues.length) return { source: `caption file downloaded by the player (${r.url.length > 100 ? `${r.url.slice(0, 99)}…` : r.url})`, cues };
  }
  return null;
}

function cueLines(cues: Cue[]): string {
  return cues.map((c) => `[${formatSeconds(c.start)} → ${formatSeconds(c.end)}] ${c.text}`).join('\n');
}

// ---- transcription ----

interface Transcript {
  segments: Array<{ start: number; end: number; text: string }>;
  text: string;
  seconds: number;
  silent: boolean;
  level: number;
  model?: string;
  elapsedMs?: number;
}

const captureListeners = new Map<string, (seq: number, data: string) => void>();

async function captureByStreaming(core: Core, ctx: CallContext, media: Media, start: number, seconds: number, append: (data: string) => void): Promise<number> {
  const { tabId, signal } = ctx;
  await core.page.ensureBinding(tabId, media.entry.sessionId);
  const captureId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  captureListeners.set(captureId, (_seq, data) => append(data));
  const state = await core.page.callOn<ReturnType<typeof playbackState>>(media.entry, playbackState);
  let captured = -2;
  try {
    await core.page.callOn(media.entry, controlMedia, ['seek', start]);
    let started: { ok: boolean; error?: string };
    try {
      started = await core.page.callOn<{ ok: boolean; error?: string }>(media.entry, startAudioCapture, [captureId], { userGesture: true });
    } catch (error) {
      if (/cross-origin/i.test(errorMessage(error))) {
        throw new ToolError('This media is cross-origin without CORS, so Chrome forbids capturing its audio from the element. Use source="decode" (the extension downloads and decodes the file itself) or source="tab" after the user clicks the Neo WebMCP icon on this tab.');
      }
      throw error;
    }
    if (!started.ok) throw new ToolError(`Cannot capture this element's audio: ${started.error}`);
    const play = await core.page.callOn<string>(media.entry, controlMedia, ['play'], { userGesture: true });
    if (play.startsWith('blocked')) throw new ToolError(`The page blocked playback (${play}).`);
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      await sleep(Math.min(500, until - Date.now()), signal);
      const s = await core.page.callOn<ReturnType<typeof playbackState>>(media.entry, playbackState);
      if (s.ended) break;
      if (s.currentTime >= start + seconds) break;
    }
  } finally {
    captured = await core.page.callOn<number>(media.entry, stopAudioCapture, [captureId]).catch(() => -2);
    captureListeners.delete(captureId);
    await core.page.callOn(media.entry, restoreState, [state], { userGesture: true }).catch(() => {});
  }
  if (captured === -1) throw new ToolError('The element produced no audio track to capture (the video may have no sound, or the player hides its audio from capture).');
  return captured;
}

async function captureByDecoding(core: Core, media: Media, start: number, seconds: number, append: (data: string) => void): Promise<number> {
  const res = await core.offscreen.call<{ id: string; chunks: number; seconds: number }>('audio.decode', { url: media.info.src, start, duration: seconds, maxBytes: 300 * 1024 * 1024 });
  try {
    for (let i = 0; i < res.chunks; i++) append(await core.offscreen.call<string>('audio.chunk', { id: res.id, index: i }));
  } finally {
    await core.offscreen.call('audio.release', { id: res.id }).catch(() => {});
  }
  return res.seconds;
}

async function captureFromTab(core: Core, ctx: CallContext, media: Media, start: number, seconds: number, append: (data: string) => void): Promise<number> {
  let streamId: string;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: ctx.tabId });
  } catch (error) {
    throw new ToolError(`Tab audio capture is not permitted (${errorMessage(error)}). The user must click the Neo WebMCP toolbar icon while this tab is active to allow it.`);
  }
  const state = await core.page.callOn<ReturnType<typeof playbackState>>(media.entry, playbackState);
  try {
    await core.page.callOn(media.entry, controlMedia, ['seek', start]);
    await core.page.callOn(media.entry, controlMedia, ['play'], { userGesture: true });
    const res = await core.offscreen.call<{ id: string; chunks: number; seconds: number }>('tabcapture.record', { streamId, seconds });
    for (let i = 0; i < res.chunks; i++) append(await core.offscreen.call<string>('audio.chunk', { id: res.id, index: i }));
    await core.offscreen.call('audio.release', { id: res.id }).catch(() => {});
    return res.seconds;
  } finally {
    await core.page.callOn(media.entry, restoreState, [state], { userGesture: true }).catch(() => {});
  }
}

type Strategy = 'decode' | 'stream' | 'tab';

const STRATEGY_LABEL: Record<Strategy, string> = { decode: 'decoded media file', stream: 'real-time capture while playing', tab: 'tab audio capture' };

/** Captures one segment with one strategy and transcribes it with Whisper on the bridge. */
async function runStrategy(core: Core, ctx: CallContext, media: Media, strategy: Strategy, opts: { start: number; seconds: number; language?: string; model: string }): Promise<{ transcript: Transcript; source: string }> {
  const { session } = ctx;
  const { id } = await session.service<{ id: number }>('audio.begin', { sampleRate: 16000 });
  let chain = Promise.resolve();
  const append = (data: string) => {
    chain = chain.then(() => session.service('audio.append', { id, data }).then(() => {}));
  };
  try {
    if (strategy === 'decode') await captureByDecoding(core, media, opts.start, opts.seconds, append);
    else if (strategy === 'tab') await captureFromTab(core, ctx, media, opts.start, opts.seconds, append);
    else await captureByStreaming(core, ctx, media, opts.start, opts.seconds, append);
    await chain;
    const transcript = await session.service<Transcript>('audio.transcribe', { id, language: opts.language, model: opts.model, offset: opts.start });
    return { transcript, source: STRATEGY_LABEL[strategy] };
  } catch (error) {
    await chain.catch(() => {});
    await session.service('audio.discard', { id }).catch(() => {});
    throw error;
  }
}

/** source "auto" (BRD 2.2.10): decode the file when it has a URL, else capture the element while it plays, else capture the whole tab if the user allowed it. */
async function transcribe(core: Core, ctx: CallContext, media: Media, opts: { start: number; seconds: number; language?: string; source: string; model: string }): Promise<{ transcript: Transcript; source: string }> {
  if (opts.source !== 'auto') return runStrategy(core, ctx, media, opts.source as Strategy, opts);
  const i = media.info;
  const direct = /^https?:/i.test(i.src) && !i.blob && !i.drm && (i.duration ?? 0) > 0;
  const failures: string[] = [];
  for (const strategy of (direct ? ['decode', 'stream', 'tab'] : ['stream', 'tab']) as Strategy[]) {
    try {
      const result = await runStrategy(core, ctx, media, strategy, opts);
      return failures.length ? { ...result, source: `${result.source} (${failures.join('; ')})` } : result;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      failures.push(`${STRATEGY_LABEL[strategy]} failed: ${errorMessage(error)}`);
    }
  }
  throw new ToolError(`Could not capture the audio of this video. ${failures.join(' ')}`);
}

function silentError(t: Transcript, source: string): ToolError {
  return new ToolError(
    `The captured audio is silent (level ${t.level.toFixed(5)}, ${t.seconds.toFixed(1)} s via ${source}), so there is nothing to transcribe. Likely causes: the segment has no sound, the media is cross-origin without CORS (capture then yields silence), or it is DRM-protected. Try source="decode" for direct files, or source="tab" after the user clicks the Neo WebMCP icon on this tab.`,
  );
}

function transcriptLines(t: Transcript): string {
  return t.segments.map((s) => `[${formatSeconds(s.start)} → ${formatSeconds(s.end)}] ${s.text}`).join('\n') || t.text;
}

export const videoFeature: Feature = {
  name: 'video',
  setup(core) {
    core.cdp.on((tabId, sessionId, method, params) => {
      if (method === 'Runtime.bindingCalled' && params.name === '__neoEmit') {
        try {
          const msg = JSON.parse(params.payload) as { captureId?: string; seq: number; data: string };
          if (msg.captureId) captureListeners.get(msg.captureId)?.(msg.seq, msg.data);
        } catch {
          /* not ours */
        }
        return;
      }
      const key = `${tabId}|${sessionId ?? ''}|${params?.requestId}`;
      if (method === 'Network.responseReceived') {
        const url: string = params.response.url;
        const mime: string = params.response.mimeType ?? '';
        if (looksLikeCaptionUrl(url, mime)) {
          let list = captionResponses.get(tabId);
          if (!list) captionResponses.set(tabId, (list = []));
          list.push({ requestId: params.requestId, sessionId, url, mime, finished: false, at: Date.now() });
          if (list.length > 30) list.shift();
        }
        if (params.type === 'Media' || /^(video|audio)\/|mpegurl|dash\+xml|mp2t/i.test(mime) || /videoplayback|\.m4s(\?|$)|\.ts(\?|$)/.test(url)) {
          mediaRequests.set(key, { tabId, mime, url });
          if (mediaRequests.size > 500) mediaRequests.delete(mediaRequests.keys().next().value!);
        }
      } else if (method === 'Network.dataReceived') {
        if (mediaRequests.has(key)) {
          let samples = mediaBytes.get(tabId);
          if (!samples) mediaBytes.set(tabId, (samples = []));
          samples.push({ at: Date.now(), bytes: params.encodedDataLength || params.dataLength || 0 });
          if (samples.length > 3000) samples.splice(0, samples.length - 3000);
        }
      } else if (method === 'Network.loadingFinished') {
        const r = captionResponses.get(tabId)?.find((x) => x.requestId === params.requestId && (x.sessionId ?? '') === (sessionId ?? ''));
        if (r) r.finished = true;
      }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      captionResponses.delete(tabId);
      mediaBytes.delete(tabId);
    });
  },
  handlers: {
    async video_list(_args, { core, tabId }) {
      const list = await listMedia(core, tabId);
      if (!list.length) return 'No video or audio elements on this page (checked iframes and shadow DOM).';
      const tab = await chrome.tabs.get(tabId);
      const main = pickMain(list);
      return `${list.length} media element${list.length === 1 ? '' : 's'}${main ? ` (main: [${main.entry.ref}])` : ''}:\n${list.map((m) => describe(m, platformOf(m.entry.sessionId ? core.cdp.child(tabId, m.entry.sessionId)?.url : tab.url))).join('\n')}`;
    },

    async video_control(args: { action: string; video?: string; time?: number; rate?: number; volume?: number }, { core, tabId }) {
      const media = await resolveMedia(core, tabId, args.video);
      const value = args.action === 'seek' ? args.time : args.action === 'rate' ? args.rate : args.action === 'volume' ? args.volume : undefined;
      if (args.action === 'seek' && value === undefined) throw new ToolError('time is required for seek.');
      const result = await core.page.callOn<string>(media.entry, controlMedia, [args.action, value], { userGesture: true });
      if (result.startsWith('blocked')) throw new ToolError(`Playback was blocked by the page or browser: ${result}`);
      const info = await core.page.callOn<MediaInfo>(media.entry, mediaInfo);
      return `[${media.entry.ref}] ${result} · position ${formatSeconds(info.currentTime)} of ${info.duration === -1 ? 'live' : formatSeconds(info.duration ?? 0)} · ${info.paused ? 'paused' : 'playing'}${info.muted ? ' · muted' : ''} · volume ${info.volume} · rate ${info.playbackRate}`;
    },

    async video_frame(args: { video?: string; times?: number[]; maxWidth?: number }, { core, tabId }) {
      const media = await resolveMedia(core, tabId, args.video);
      const maxWidth = args.maxWidth ?? 960;
      const frames: Frame[] = [];
      if (args.times?.length) {
        const dur = media.info.duration ?? 0;
        await preservingPlayback(core, media, async () => {
          for (const t of args.times!) frames.push(await captureFrame(core, tabId, media, maxWidth, dur > 0 ? Math.min(Math.max(0, t), dur - 0.05) : t));
        });
      } else frames.push(await captureFrame(core, tabId, media, maxWidth));
      const content: ToolContent[] = [{ type: 'text', text: `${frames.length} frame${frames.length === 1 ? '' : 's'} of [${media.entry.ref}]${args.times?.length ? '; playback position and state restored' : ''}.${frames.some((f) => f.method === 'screen') ? ` Captured from the screen (${media.info.drm ? 'encrypted frames cannot be read directly' : 'the video is cross-origin'}).` : ''}` }];
      for (const f of frames) {
        if (f.drmBlack) content.push({ type: 'text', text: `Frame at ${formatSeconds(f.time)}: blocked by DRM (protected video renders black in captures).` });
        else {
          content.push({ type: 'text', text: `Frame at ${formatSeconds(f.time)}:` });
          content.push(imageContent(f.data, 'image/jpeg'));
        }
      }
      return content;
    },

    async video_storyboard(args: { video?: string; start?: number; end?: number; count?: number; columns?: number; tileWidth?: number }, { core, tabId, signal }) {
      const media = await resolveMedia(core, tabId, args.video);
      const sb = await storyboard(core, tabId, media, { start: args.start, end: args.end, count: args.count ?? 12, columns: args.columns, tileWidth: args.tileWidth ?? 320, signal });
      if (sb.drm) throw new ToolError('The storyboard came out black: the video is DRM-protected and Chrome does not let captures see it.');
      return [
        { type: 'text', text: `Storyboard of [${media.entry.ref}]: ${sb.times.length} frames (${sb.live ? 'sampled while playing' : `${formatSeconds(sb.times[0] ?? 0)} – ${formatSeconds(sb.times.at(-1) ?? 0)}`}, ${sb.method}), each tile stamped with its time. Times: ${sb.times.map(formatSeconds).join(', ')}. ${sb.live ? '' : 'Playback position and state were restored.'}` },
        imageContent(sb.image.data, sb.image.mimeType),
      ];
    },

    async video_captions(args: { video?: string; language?: string; start?: number; end?: number }, { core, tabId, signal }) {
      const media = await resolveMedia(core, tabId, args.video);
      const caps = await getCaptions(core, tabId, media, args.language ?? null, signal);
      if (!caps) {
        return { content: [{ type: 'text', text: `[${media.entry.ref}] has no captions: no HTML5 caption tracks, no platform captions and no caption files in the network log. Use video_transcribe to transcribe the audio locally with Whisper.` }], isError: true };
      }
      const cues = caps.cues.filter((c) => (args.start === undefined || c.end >= args.start) && (args.end === undefined || c.start <= args.end));
      return `Captions of [${media.entry.ref}] from ${caps.source}${caps.language ? ` (${caps.language})` : ''}${caps.available?.length ? `; available: ${caps.available.join(', ')}` : ''} — ${cues.length} cues:\n${cueLines(cues)}`;
    },

    async video_transcribe(args: { video?: string; start?: number; duration?: number; language?: string; source?: string; model?: string }, ctx) {
      const { core, tabId } = ctx;
      const media = await resolveMedia(core, tabId, args.video);
      const i = media.info;
      const start = Math.max(0, args.start ?? i.currentTime);
      const remaining = (i.duration ?? 0) > 0 ? i.duration! - start : Number.POSITIVE_INFINITY;
      const seconds = Math.min(args.duration ?? 60, remaining, 1800);
      if (seconds <= 0.2) throw new ToolError(`Nothing to transcribe: the segment starts at the end of the media (${formatSeconds(start)}).`);
      const model = args.model ?? core.settings.get().whisperModel;
      const { transcript, source } = await transcribe(core, ctx, media, { start, seconds, language: args.language, source: args.source ?? 'auto', model });
      if (transcript.silent) throw silentError(transcript, source);
      return `Transcript of [${media.entry.ref}] ${formatSeconds(start)} – ${formatSeconds(start + transcript.seconds)} (local Whisper ${model}${transcript.model ? ` = ${transcript.model}` : ''}, audio from ${source}, ${((transcript.elapsedMs ?? 0) / 1000).toFixed(1)} s):\n${transcriptLines(transcript)}`;
    },

    async video_watch(args: { video?: string; start?: number; duration?: number; frames?: number; speech?: string; language?: string }, ctx) {
      const { core, tabId, signal } = ctx;
      const media = await resolveMedia(core, tabId, args.video);
      const i = media.info;
      const tab = await chrome.tabs.get(tabId);
      const platform = platformOf(media.entry.sessionId ? core.cdp.child(tabId, media.entry.sessionId)?.url : tab.url);
      const start = Math.max(0, args.start ?? 0);
      const length = (i.duration ?? 0) > 0 ? i.duration! - start : 30;
      const duration = Math.max(0.5, Math.min(args.duration ?? Math.min(DEFAULT_WATCH_SECONDS, length), length));
      const sb = await storyboard(core, tabId, media, { start, end: start + duration, count: args.frames ?? 12, tileWidth: 320, signal });
      const mode = args.speech ?? 'auto';
      let speech = 'Speech: not requested.';
      const notes: string[] = [];
      if (mode !== 'none') {
        let done = false;
        if (mode === 'auto' || mode === 'captions') {
          const caps = await getCaptions(core, tabId, media, args.language ?? null, signal);
          const cues = caps?.cues.filter((c) => c.end >= start && c.start <= start + duration) ?? [];
          if (caps && cues.length) {
            speech = `Speech (from ${caps.source}${caps.language ? `, ${caps.language}` : ''}):\n${cueLines(cues)}`;
            done = true;
          } else if (mode === 'captions') {
            speech = 'Speech: no captions cover this segment.';
            done = true;
          }
        }
        if (!done) {
          const realtime = !(/^https?:/i.test(i.src) && !i.blob && !i.drm && (i.duration ?? 0) > 0);
          const seconds = realtime ? Math.min(duration, 180) : duration;
          if (seconds < duration) notes.push(`Only the first ${seconds} s were transcribed because this player needs real-time capture; call video_transcribe with start=${start + seconds} for the rest.`);
          try {
            const { transcript, source } = await transcribe(core, ctx, media, { start, seconds, language: args.language, source: 'auto', model: core.settings.get().whisperModel });
            speech = transcript.silent ? `Speech: none detected (audio is silent via ${source}).` : `Speech (local Whisper transcription, audio from ${source}):\n${transcriptLines(transcript)}`;
          } catch (error) {
            speech = `Speech: transcription failed — ${errorMessage(error)}`;
          }
        }
      }
      const header = describe(media, platform);
      return [
        {
          type: 'text',
          text: [
            `Watched ${formatSeconds(start)} – ${formatSeconds(start + duration)} of "${i.pageTitle}"`,
            header,
            `Storyboard: ${sb.times.length} frames at ${sb.times.map(formatSeconds).join(', ')} (${sb.method}; image below)${sb.drm ? ' — frames are black because the video is DRM-protected' : ''}.`,
            speech,
            ...notes,
          ].join('\n'),
        },
        imageContent(sb.image.data, sb.image.mimeType),
      ];
    },

    async media_inspect(args: { video?: string; sampleMs?: number }, { core, tabId, session }) {
      const media = await resolveMedia(core, tabId, args.video);
      const i = media.info;
      const sample = i.tag === 'video' ? await core.page.callOn<Awaited<ReturnType<typeof sampleMedia>>>(media.entry, sampleMedia, [args.sampleMs ?? 1000]) : null;
      const after = await core.page.callOn<MediaInfo>(media.entry, mediaInfo);
      const lines = [
        `[${media.entry.ref}] ${i.tag}${after.width ? ` ${after.width}×${after.height}` : ''} · ${after.paused ? 'paused' : 'playing'} at ${formatSeconds(after.currentTime)} of ${after.duration === -1 ? 'live' : formatSeconds(after.duration ?? 0)}`,
        `State: readyState ${after.readyState} (${READY[after.readyState]}) · networkState ${after.networkState} (${NETWORK[after.networkState]}) · buffered ${after.buffered.map(([a, b]) => `${a}–${b}s`).join(', ') || 'nothing'} · seekable ${after.seekable.map(([a, b]) => `${a}–${b}s`).join(', ') || 'no'}`,
        sample ? `Rendering: ${sample.fps !== null ? `${sample.fps} fps measured` : 'frame rate not measurable while paused'} · dropped frames ${after.dropped ?? 'n/a'} of ${after.totalFrames ?? 'n/a'} total${sample.droppedDuring !== null ? ` (${sample.droppedDuring} during the ${args.sampleMs ?? 1000} ms sample)` : ''}` : '',
        `Source: ${after.blob ? 'MediaSource (adaptive stream)' : after.src}${after.drm ? ' · DRM (Encrypted Media Extensions)' : ''}${after.error ? ` · ERROR ${after.error.code}: ${after.error.message}` : ''}`,
      ];
      const samples = (mediaBytes.get(tabId) ?? []).filter((s) => Date.now() - s.at < 20_000);
      if (samples.length) {
        const span = Math.max(1, (Date.now() - samples[0]!.at) / 1000);
        lines.push(`Network: ~${Math.round((samples.reduce((a, s) => a + s.bytes, 0) * 8) / span / 1000)} kbit/s of media data over the last ${Math.round(span)} s`);
      }
      if (sample?.events.length) lines.push(`Events during sample: ${sample.events.map((e) => `${e.type}@${e.t}ms`).join(', ')}`);
      try {
        const { events } = await session.service<{ events: Array<{ method: string; params: any }> }>('fdc.media', { targetId: await core.targetIdFor(tabId), waitMs: 800 });
        const players = new Map<string, { domNodeId?: number; props: Record<string, string>; messages: string[]; errors: string[] }>();
        const get = (id: string) => {
          let p = players.get(id);
          if (!p) players.set(id, (p = { props: {}, messages: [], errors: [] }));
          return p;
        };
        for (const e of events) {
          // Chrome 155 sends playerCreated {player}; older builds sent playersCreated {players}.
          const created = e.method === 'Media.playerCreated' ? [e.params.player] : e.method === 'Media.playersCreated' ? (e.params.players ?? []) : [];
          for (const p of created) get(typeof p === 'string' ? p : p.playerId).domNodeId = typeof p === 'string' ? undefined : p.domNodeId;
          if (e.method === 'Media.playerPropertiesChanged') for (const prop of e.params.properties ?? []) get(e.params.playerId).props[prop.name] = prop.value;
          if (e.method === 'Media.playerMessagesLogged') for (const m of e.params.messages ?? []) get(e.params.playerId).messages.push(`${m.level}: ${m.message}`);
          if (e.method === 'Media.playerErrorsRaised') for (const err of e.params.errors ?? []) get(e.params.playerId).errors.push(JSON.stringify(err));
        }
        const mine = [...players.values()].find((p) => p.domNodeId === media.entry.backendNodeId) ?? (players.size === 1 ? [...players.values()][0] : undefined);
        if (mine) {
          lines.push(`Media panel (full DevTools channel): ${mediaPanelSummary(mine.props)}`);
          if (mine.messages.length) lines.push(`Player messages: ${mine.messages.slice(-8).join(' | ')}`);
          if (mine.errors.length) lines.push(`Player errors: ${mine.errors.join(' | ')}`);
        } else lines.push(`Media panel: ${players.size} players reported, none matched this element.`);
      } catch (error) {
        lines.push(`Codec and decoder details (DevTools Media panel) need the full DevTools channel: ${errorMessage(error)}`);
      }
      return lines.filter(Boolean).join('\n');
    },
  },
};


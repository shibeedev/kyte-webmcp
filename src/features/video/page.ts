/**
 * Functions injected into pages (CDP isolated world) for the video feature.
 * Self-contained: no imports or outer references. `this` is the media element.
 */

export function findMediaElements(): Element[] {
  const out: Element[] = [];
  const visit = (root: ParentNode) => {
    for (const e of Array.from(root.querySelectorAll('video, audio'))) out.push(e);
    for (const e of Array.from(root.querySelectorAll('*'))) {
      const sr = (e as HTMLElement).shadowRoot;
      if (sr) visit(sr);
    }
  };
  visit(document);
  return out;
}

export function mediaInfo(this: HTMLMediaElement) {
  const m = this;
  const r = m.getBoundingClientRect();
  const vw = innerWidth;
  const vh = innerHeight;
  const visibleArea = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  const ranges = (tr: TimeRanges) => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < tr.length; i++) out.push([Math.round(tr.start(i) * 10) / 10, Math.round(tr.end(i) * 10) / 10]);
    return out;
  };
  const video = m as HTMLVideoElement;
  const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
  const label = m.getAttribute('aria-label') || m.getAttribute('title') || m.closest('figure')?.querySelector('figcaption')?.textContent?.trim() || '';
  return {
    tag: m.tagName.toLowerCase(),
    src: m.currentSrc || m.src || '',
    duration: Number.isFinite(m.duration) ? m.duration : m.duration === Infinity ? -1 : null,
    currentTime: m.currentTime,
    paused: m.paused,
    ended: m.ended,
    muted: m.muted,
    volume: m.volume,
    playbackRate: m.playbackRate,
    readyState: m.readyState,
    networkState: m.networkState,
    width: video.videoWidth ?? 0,
    height: video.videoHeight ?? 0,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    visibleArea: Math.round(visibleArea),
    drm: !!m.mediaKeys,
    error: m.error ? { code: m.error.code, message: m.error.message } : null,
    tracks: Array.from(m.textTracks ?? []).map((t) => ({ kind: t.kind, label: t.label, language: t.language, mode: t.mode, cues: t.cues ? t.cues.length : null })),
    hasAudio: (m as unknown as { audioTracks?: { length: number } }).audioTracks ? (m as unknown as { audioTracks: { length: number } }).audioTracks.length > 0 : null,
    dropped: quality?.droppedVideoFrames ?? null,
    totalFrames: quality?.totalVideoFrames ?? null,
    buffered: ranges(m.buffered),
    seekable: ranges(m.seekable),
    blob: (m.currentSrc || '').startsWith('blob:'),
    loop: m.loop,
    autoplay: m.autoplay,
    controls: m.controls,
    poster: video.poster || '',
    crossOrigin: m.crossOrigin,
    label: label.slice(0, 120),
    pageTitle: document.title,
  };
}

export async function controlMedia(this: HTMLMediaElement, action: string, value?: number): Promise<string> {
  const m = this;
  switch (action) {
    case 'play':
      try {
        await m.play();
        return 'playing';
      } catch (e) {
        return `blocked: ${(e as Error).message}`;
      }
    case 'pause':
      m.pause();
      return 'paused';
    case 'seek':
      await new Promise<void>((resolve) => {
        const done = () => {
          m.removeEventListener('seeked', done);
          resolve();
        };
        m.addEventListener('seeked', done);
        m.currentTime = value ?? 0;
        setTimeout(done, 8000);
      });
      return `at ${m.currentTime.toFixed(2)}s`;
    case 'rate':
      m.playbackRate = value ?? 1;
      return `rate ${m.playbackRate}`;
    case 'mute':
      m.muted = true;
      return 'muted';
    case 'unmute':
      m.muted = false;
      return 'unmuted';
    case 'volume':
      m.volume = Math.max(0, Math.min(1, value ?? 1));
      if (m.volume > 0) m.muted = false;
      return `volume ${m.volume}`;
  }
  throw new Error(`unknown action ${action}`);
}

/** Seeks precisely and waits until the frame at that time is presented. */
export async function seekTo(this: HTMLMediaElement, t: number): Promise<number> {
  const v = this as HTMLVideoElement;
  if (Math.abs(v.currentTime - t) > 0.02 || v.readyState < 2) {
    await new Promise<void>((resolve) => {
      const done = () => {
        v.removeEventListener('seeked', done);
        resolve();
      };
      v.addEventListener('seeked', done);
      v.currentTime = t;
      setTimeout(done, 8000);
    });
  }
  if (typeof v.requestVideoFrameCallback === 'function') {
    await new Promise<void>((resolve) => {
      v.requestVideoFrameCallback(() => resolve());
      setTimeout(resolve, 600);
    });
  }
  for (let i = 0; i < 30 && v.readyState < 2; i++) await new Promise((r) => setTimeout(r, 100));
  return v.currentTime;
}

/** Draws the current frame; fails with "tainted" for cross-origin media without CORS. */
export function grabFrame(this: HTMLVideoElement, maxWidth: number, quality: number) {
  const v = this;
  if (!v.videoWidth || !v.videoHeight) return { error: 'no-frame' as const, time: v.currentTime };
  const scale = Math.min(1, maxWidth / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(v.videoWidth * scale));
  c.height = Math.max(1, Math.round(v.videoHeight * scale));
  const g = c.getContext('2d');
  if (!g) return { error: 'no-canvas' as const, time: v.currentTime };
  g.drawImage(v, 0, 0, c.width, c.height);
  try {
    const url = c.toDataURL('image/jpeg', quality);
    return { data: url.slice(url.indexOf(',') + 1), width: c.width, height: c.height, time: v.currentTime };
  } catch {
    return { error: 'tainted' as const, time: v.currentTime };
  }
}

export function playbackState(this: HTMLMediaElement) {
  return { currentTime: this.currentTime, paused: this.paused, playbackRate: this.playbackRate, ended: this.ended };
}

export async function restoreState(this: HTMLMediaElement, state: { currentTime: number; paused: boolean; playbackRate: number }): Promise<void> {
  const m = this;
  m.playbackRate = state.playbackRate;
  if (Math.abs(m.currentTime - state.currentTime) > 0.05) {
    await new Promise<void>((resolve) => {
      const done = () => {
        m.removeEventListener('seeked', done);
        resolve();
      };
      m.addEventListener('seeked', done);
      m.currentTime = state.currentTime;
      setTimeout(done, 8000);
    });
  }
  if (state.paused && !m.paused) m.pause();
  if (!state.paused && m.paused) await m.play().catch(() => {});
}

export async function readTextTracks(this: HTMLMediaElement, lang: string | null) {
  const v = this;
  const tracks = Array.from(v.textTracks ?? []).filter((t) => ['captions', 'subtitles', ''].includes(t.kind));
  if (!tracks.length) return null;
  const want = lang?.toLowerCase();
  const pick = (want && tracks.find((t) => (t.language || '').toLowerCase().startsWith(want))) || tracks.find((t) => t.mode === 'showing') || tracks[0]!;
  const previous = pick.mode;
  if (pick.mode === 'disabled') pick.mode = 'hidden';
  const el = Array.from(v.querySelectorAll('track')).find((t) => t.track === pick);
  for (let i = 0; i < 60 && (!pick.cues || (el && el.readyState < 2)); i++) await new Promise((r) => setTimeout(r, 100));
  const cues = Array.from(pick.cues ?? []).map((c) => ({ start: c.startTime, end: c.endTime, text: ((c as VTTCue).text ?? '').replace(/<[^>]+>/g, '').trim() }));
  pick.mode = previous;
  return { label: pick.label, language: pick.language, kind: pick.kind, cues, available: tracks.map((t) => t.language || t.label || t.kind) };
}

/** Starts streaming the element's audio (16 kHz mono PCM) out of the page through __kyteEmit. */
export async function startAudioCapture(this: HTMLMediaElement, captureId: string): Promise<{ ok: boolean; error?: string }> {
  const m = this as HTMLMediaElement & { captureStream?: () => MediaStream };
  if (typeof m.captureStream !== 'function') return { ok: false, error: 'captureStream is not supported on this element' };
  const stream = m.captureStream();
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.resume().catch(() => {});
  const g = globalThis as unknown as { __kyteEmit?: (s: string) => void; __kyteCaptures?: Record<string, () => number> };
  const emit = g.__kyteEmit;
  if (!emit) return { ok: false, error: 'binding missing' };
  let source: MediaStreamAudioSourceNode | null = null;
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0; // the element keeps playing to the speakers itself; do not double it
  proc.connect(sink);
  sink.connect(ctx.destination);
  let seq = 0;
  let total = 0;
  let pending: Float32Array[] = [];
  const flush = () => {
    if (!pending.length) return;
    const n = pending.reduce((a, b) => a + b.length, 0);
    const pcm = new Int16Array(n);
    let o = 0;
    for (const b of pending) for (let i = 0; i < b.length; i++) pcm[o++] = Math.max(-1, Math.min(1, b[i]!)) * 32767;
    pending = [];
    const bytes = new Uint8Array(pcm.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    emit(JSON.stringify({ captureId, seq: seq++, data: btoa(bin) }));
  };
  proc.onaudioprocess = (e) => {
    pending.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    total += e.inputBuffer.length;
    if (pending.length >= 4) flush();
  };
  // MSE players may add the audio track only once playback runs.
  const attach = () => {
    if (source || !stream.getAudioTracks().length) return;
    source = ctx.createMediaStreamSource(stream);
    source.connect(proc);
  };
  attach();
  stream.addEventListener('addtrack', attach);
  g.__kyteCaptures = g.__kyteCaptures ?? {};
  g.__kyteCaptures[captureId] = () => {
    flush();
    stream.removeEventListener('addtrack', attach);
    proc.disconnect();
    source?.disconnect();
    void ctx.close();
    for (const t of stream.getTracks()) t.stop();
    delete g.__kyteCaptures![captureId];
    return source ? total / 16000 : -1;
  };
  return { ok: true };
}

export function stopAudioCapture(this: HTMLMediaElement, captureId: string): number {
  const g = globalThis as unknown as { __kyteCaptures?: Record<string, () => number> };
  const stop = g.__kyteCaptures?.[captureId];
  return stop ? stop() : -2;
}

/** YouTube player data (runs in the page's main world, where the player lives). */
export async function youtubeCaptionTracks(lang: string | null) {
  const player = document.querySelector('#movie_player') as unknown as { getPlayerResponse?: () => any; getCurrentTime?: () => number } | null;
  const response = player?.getPlayerResponse?.() ?? (window as unknown as { ytInitialPlayerResponse?: any }).ytInitialPlayerResponse;
  const tracks: Array<{ baseUrl: string; languageCode: string; name?: { simpleText?: string; runs?: Array<{ text: string }> }; kind?: string }> =
    response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) return { tracks: [], body: null as string | null };
  const want = lang?.toLowerCase();
  const pick = (want && tracks.find((t) => t.languageCode.toLowerCase().startsWith(want))) || tracks.find((t) => t.kind !== 'asr') || tracks[0]!;
  let body: string | null = null;
  try {
    const res = await fetch(`${pick.baseUrl}&fmt=json3`, { credentials: 'include' });
    body = res.ok ? await res.text() : null;
  } catch {
    body = null;
  }
  return {
    tracks: tracks.map((t) => ({ language: t.languageCode, name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? '', kind: t.kind ?? 'manual' })),
    picked: pick.languageCode,
    body: body && body.length > 20 ? body : null,
  };
}

/** Turns on YouTube captions so the player downloads them (they can then be read from the network). */
export function youtubeEnableCaptions(lang: string | null): boolean {
  const player = document.querySelector('#movie_player') as unknown as { loadModule?: (m: string) => void; setOption?: (a: string, b: string, c: unknown) => void } | null;
  if (!player?.setOption) return false;
  try {
    player.loadModule?.('captions');
    player.setOption('captions', 'track', lang ? { languageCode: lang } : {});
    player.setOption('captions', 'reload', true);
    return true;
  } catch {
    return false;
  }
}

/** Collects media events and frame rate for `ms` milliseconds (Media-panel style details). */
export async function sampleMedia(this: HTMLVideoElement, ms: number) {
  const v = this;
  const events: Array<{ t: number; type: string }> = [];
  const types = ['play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ratechange', 'ended', 'error', 'emptied', 'loadedmetadata', 'canplay', 'resize', 'volumechange'];
  const start = performance.now();
  const on = (e: Event) => events.push({ t: Math.round(performance.now() - start), type: e.type });
  for (const t of types) v.addEventListener(t, on);
  const q0 = v.getVideoPlaybackQuality?.();
  let frames = 0;
  let firstMedia = -1;
  let lastMedia = -1;
  let running = true;
  const tick = (_now: number, meta: { mediaTime: number; presentedFrames: number }) => {
    if (!running) return;
    frames++;
    if (firstMedia < 0) firstMedia = meta.mediaTime;
    lastMedia = meta.mediaTime;
    v.requestVideoFrameCallback(tick);
  };
  if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(tick);
  await new Promise((r) => setTimeout(r, ms));
  running = false;
  for (const t of types) v.removeEventListener(t, on);
  const q1 = v.getVideoPlaybackQuality?.();
  const mediaSpan = lastMedia - firstMedia;
  return {
    fps: frames > 1 && mediaSpan > 0 ? Math.round(((frames - 1) / mediaSpan) * 10) / 10 : null,
    presentedFrames: frames,
    droppedDuring: q0 && q1 ? q1.droppedVideoFrames - q0.droppedVideoFrames : null,
    events,
  };
}

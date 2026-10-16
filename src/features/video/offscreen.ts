/**
 * Offscreen-document half of the video feature: decode media files to
 * 16 kHz mono PCM and capture tab audio. Results are kept here and handed out
 * in ~1 MB base64 chunks so no single extension message gets too large.
 */
type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const CHUNK_BYTES = 1 << 20;
const results = new Map<string, Uint8Array>();
let nextId = 1;

function toBase64(u8: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

function toPcm16(samples: Float32Array): Uint8Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i]!)) * 32767;
  return new Uint8Array(pcm.buffer);
}

function store(bytes: Uint8Array, seconds: number) {
  const id = `a${nextId++}`;
  results.set(id, bytes);
  return { id, chunks: Math.ceil(bytes.length / CHUNK_BYTES), seconds, bytes: bytes.length };
}

export const videoOffscreenHandlers: Record<string, Handler> = {
  async 'audio.decode'(p) {
    const url = String(p.url);
    const start = Math.max(0, Number(p.start ?? 0));
    const duration = Number(p.duration ?? 60);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`fetching the media file failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > Number(p.maxBytes)) throw new Error(`the media file is too large to decode directly (${declared} bytes)`);
    const encoded = await res.arrayBuffer();
    const decoded = await new OfflineAudioContext(1, 1, 44_100).decodeAudioData(encoded);
    const end = Math.min(decoded.duration, start + duration);
    if (end <= start) throw new Error('the requested segment is outside the media');
    const frames = Math.ceil((end - start) * 16_000);
    const ctx = new OfflineAudioContext(1, frames, 16_000);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    src.start(0, start, end - start);
    const rendered = await ctx.startRendering();
    return store(toPcm16(rendered.getChannelData(0)), end - start);
  },

  async 'audio.chunk'(p) {
    const bytes = results.get(String(p.id));
    if (!bytes) throw new Error('unknown audio result');
    const i = Number(p.index);
    return toBase64(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
  },

  async 'audio.release'(p) {
    results.delete(String(p.id));
    return true;
  },

  async 'tabcapture.record'(p) {
    const seconds = Number(p.seconds);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: String(p.streamId) } } as unknown as MediaTrackConstraints,
      video: false,
    });
    const ctx = new AudioContext({ sampleRate: 16_000 });
    const source = ctx.createMediaStreamSource(stream);
    // Capturing a tab mutes it for the user: route the audio back to the speakers.
    source.connect(ctx.destination);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    const parts: Float32Array[] = [];
    proc.onaudioprocess = (e) => parts.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    await new Promise((r) => setTimeout(r, seconds * 1000));
    proc.disconnect();
    source.disconnect();
    for (const t of stream.getTracks()) t.stop();
    await ctx.close();
    const total = parts.reduce((a, b) => a + b.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const part of parts) {
      all.set(part, o);
      o += part.length;
    }
    return store(toPcm16(all), total / 16_000);
  },
};

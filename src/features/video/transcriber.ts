/**
 * Bridge-side half of video transcription: the extension streams 16 kHz mono
 * PCM (Int16, base64) and Whisper runs locally through transformers.js.
 * Audio never leaves the machine; the model is downloaded once and cached.
 */
import os from 'node:os';
import path from 'node:path';
import type { ServiceHandler } from '../../bridge/hub.ts';
import { log } from '../../bridge/log.ts';

export const WHISPER_MODELS = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
} as const;
export type WhisperSize = keyof typeof WHISPER_MODELS;

export function modelCacheDir(): string {
  return process.env.KYTE_WEBMCP_MODEL_DIR ?? path.join(os.homedir(), '.cache', 'kyte-webmcp', 'models');
}

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>;

const loaded = new Map<WhisperSize, Promise<Transcriber>>();

async function loadModel(size: WhisperSize): Promise<Transcriber> {
  let promise = loaded.get(size);
  if (!promise) {
    promise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const started = Date.now();
      let lastLog = 0;
      const asr = await pipeline('automatic-speech-recognition', WHISPER_MODELS[size], {
        cache_dir: modelCacheDir(),
        device: 'cpu',
        dtype: 'q8',
        progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
          if (p.status === 'progress' && Date.now() - lastLog > 2000) {
            lastLog = Date.now();
            log(`downloading Whisper ${size}: ${p.file} ${Math.round(p.progress ?? 0)}%`);
          }
        },
      });
      log(`Whisper ${size} ready in ${Date.now() - started} ms`);
      return asr as unknown as Transcriber;
    })();
    promise.catch(() => loaded.delete(size));
    loaded.set(size, promise);
  }
  return promise;
}

interface AudioStream {
  chunks: Buffer[];
  bytes: number;
  sampleRate: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Root-mean-square level of 16-bit PCM, used to tell silence from speech. */
export function rmsLevel(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i]! / 32768) ** 2;
  return Math.sqrt(sum / pcm.length);
}

export function transcriberServices(): Record<string, ServiceHandler> {
  const streams = new Map<number, AudioStream>();
  let nextId = 1;
  return {
    'audio.begin': async (a) => {
      const id = nextId++;
      streams.set(id, { chunks: [], bytes: 0, sampleRate: Number(a.sampleRate ?? 16000) });
      return { id };
    },
    'audio.append': async (a) => {
      const s = streams.get(Number(a.id));
      if (!s) throw new Error('Unknown audio stream');
      const buf = Buffer.from(String(a.data), 'base64');
      s.chunks.push(buf);
      s.bytes += buf.length;
      return { bytes: s.bytes };
    },
    'audio.discard': async (a) => {
      streams.delete(Number(a.id));
      return { ok: true };
    },
    'audio.transcribe': async (a) => {
      const s = streams.get(Number(a.id));
      if (!s) throw new Error('Unknown audio stream');
      streams.delete(Number(a.id));
      if (s.sampleRate !== 16000) throw new Error('audio must be 16 kHz');
      const all = Buffer.concat(s.chunks);
      const pcm = new Int16Array(all.buffer, all.byteOffset, Math.floor(all.length / 2));
      const seconds = pcm.length / 16000;
      const level = rmsLevel(pcm);
      if (level < 0.0005) return { segments: [], text: '', seconds, silent: true, level };
      const float = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float[i] = pcm[i]! / 32768;
      const size = (String(a.model ?? 'base') as WhisperSize) in WHISPER_MODELS ? (String(a.model ?? 'base') as WhisperSize) : 'base';
      const asr = await loadModel(size);
      const started = Date.now();
      const out = await asr(float, {
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(a.language ? { language: String(a.language), task: 'transcribe' } : {}),
      });
      const offset = Number(a.offset ?? 0);
      const segments: TranscriptSegment[] = (out.chunks ?? [{ timestamp: [0, seconds], text: out.text }]).map((c) => ({
        start: Math.round((offset + (c.timestamp[0] ?? 0)) * 100) / 100,
        end: Math.round((offset + (c.timestamp[1] ?? seconds)) * 100) / 100,
        text: c.text.trim(),
      }));
      return { segments, text: out.text.trim(), seconds, silent: false, level, model: WHISPER_MODELS[size], elapsedMs: Date.now() - started };
    },
  };
}

/** Caption file parsers: WebVTT, SRT, TTML/DFXP, YouTube json3 and srv3/timedtext XML. */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function clock(t: string): number {
  const m = t.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return Number.NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? '0').padEnd(3, '0')) / 1000;
}

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx]!.split('-->');
    const start = clock(a!.trim().split(/\s+/)[0]!);
    const end = clock(b!.trim().split(/\s+/)[0]!);
    const body = stripTags(lines.slice(idx + 1).join(' '));
    if (Number.isFinite(start) && Number.isFinite(end) && body) cues.push({ start, end, text: body });
  }
  return cues;
}

/** SRT is VTT with comma decimals and numeric headers; the same block parser handles it. */
export const parseSrt = parseVtt;

function ttmlTime(t: string | undefined, tickRate: number, frameRate: number): number {
  if (!t) return Number.NaN;
  const m = t.match(/^([\d.]+)(h|m|s|ms|t|f)$/);
  if (m) {
    const n = Number(m[1]);
    return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : m[2] === 's' ? n : m[2] === 'ms' ? n / 1000 : m[2] === 'f' ? n / frameRate : n / tickRate;
  }
  // HH:MM:SS:FF carries a frame count; HH:MM:SS(.fff) is a plain clock time.
  const frames = t.match(/^(\d+):(\d{2}):(\d{2}):(\d+)$/);
  if (frames) return Number(frames[1]) * 3600 + Number(frames[2]) * 60 + Number(frames[3]) + Number(frames[4]) / frameRate;
  return clock(t);
}

const attr = (attrs: string, name: string) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]+)"`))?.[1];

export function parseTtml(xml: string): Cue[] {
  const tickRate = Number(xml.match(/tickRate="(\d+)"/)?.[1] ?? 10_000_000);
  const frameRate = Number(xml.match(/frameRate="(\d+)"/)?.[1] ?? 30);
  const cues: Cue[] = [];
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const attrs = m[1]!;
    const begin = ttmlTime(attr(attrs, 'begin'), tickRate, frameRate);
    let end = ttmlTime(attr(attrs, 'end'), tickRate, frameRate);
    const dur = ttmlTime(attr(attrs, 'dur'), tickRate, frameRate);
    if (!Number.isFinite(end) && Number.isFinite(dur)) end = begin + dur;
    const text = stripTags(m[2]!.replace(/<br\s*\/?>/g, ' '));
    if (Number.isFinite(begin) && text) cues.push({ start: begin, end: Number.isFinite(end) ? end : begin, text });
  }
  return cues;
}

export function parseYoutubeJson3(text: string): Cue[] {
  const data = JSON.parse(text) as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> };
  const cues: Cue[] = [];
  for (const e of data.events ?? []) {
    if (!e.segs) continue;
    const body = e.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const start = (e.tStartMs ?? 0) / 1000;
    cues.push({ start, end: start + (e.dDurationMs ?? 0) / 1000, text: body });
  }
  return cues;
}

/** YouTube srv1/srv3 timedtext XML: <text start dur> or <p t d>. */
export function parseTimedTextXml(xml: string): Cue[] {
  const cues: Cue[] = [];
  // Attributes are read separately: a single regex with optional groups silently drops "dur".
  for (const m of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const start = Number(attr(m[1]!, 'start'));
    const body = stripTags(m[2]!);
    if (Number.isFinite(start) && body) cues.push({ start, end: start + Number(attr(m[1]!, 'dur') ?? 0), text: body });
  }
  if (cues.length) return cues;
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const t = attr(m[1]!, 't');
    const body = stripTags(m[2]!);
    if (t !== undefined && body) cues.push({ start: Number(t) / 1000, end: (Number(t) + Number(attr(m[1]!, 'd') ?? 0)) / 1000, text: body });
  }
  return cues;
}

/** Picks the right parser from the URL, MIME type and content. */
export function parseCaptions(body: string, url = '', mime = ''): Cue[] {
  const head = body.trimStart().slice(0, 200);
  if (head.startsWith('WEBVTT') || /\.vtt(\?|$)/i.test(url) || mime.includes('vtt')) return parseVtt(body);
  if (head.startsWith('{') && body.includes('"events"')) return parseYoutubeJson3(body);
  if (/<tt\b|ttml|dfxp/i.test(head) || mime.includes('ttml')) return parseTtml(body);
  if (head.startsWith('<') && /<(text|timedtext|transcript)\b/i.test(body)) return parseTimedTextXml(body);
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/m.test(body) || /\.srt(\?|$)/i.test(url)) return parseSrt(body);
  if (head.startsWith('<')) return parseTtml(body);
  return [];
}

export function looksLikeCaptionUrl(url: string, mime: string): boolean {
  return /\.(vtt|srt|ttml|dfxp)(\?|$)|timedtext|caption|subtitle/i.test(url) || /text\/vtt|ttml|x-subrip/i.test(mime);
}

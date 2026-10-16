import { fromBase64, toBase64 } from './util.ts';

/** Image work done in the service worker with OffscreenCanvas (no page involvement). */

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export interface EncodedImage {
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

export function mimeOf(format: ImageFormat): string {
  return `image/${format}`;
}

export async function decode(data: string, mimeType: string): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([fromBase64(data) as BlobPart], { type: mimeType }));
}

async function encode(canvas: OffscreenCanvas, format: ImageFormat, quality: number): Promise<EncodedImage> {
  const blob = await canvas.convertToBlob({ type: mimeOf(format), quality: quality / 100 });
  return { data: toBase64(await blob.arrayBuffer()), mimeType: mimeOf(format), width: canvas.width, height: canvas.height };
}

/** Re-encodes an image, scaled down so it is at most `maxWidth` wide. */
export async function scaleImage(data: string, mimeType: string, maxWidth: number, format: ImageFormat, quality: number): Promise<EncodedImage> {
  const bitmap = await decode(data, mimeType);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const g = canvas.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return encode(canvas, format, quality);
}

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

const PALETTE = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#4d7c0f'];

/** Draws Set-of-Mark boxes. Box coordinates are in source-image pixels. */
export async function annotateImage(data: string, mimeType: string, boxes: LabelBox[], maxWidth: number, format: ImageFormat, quality: number): Promise<EncodedImage> {
  const bitmap = await decode(data, mimeType);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d')!;
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const font = Math.max(10, Math.round(12 * Math.max(scale, 0.75)));
  g.font = `bold ${font}px sans-serif`;
  g.textBaseline = 'top';
  boxes.forEach((b, i) => {
    const color = PALETTE[i % PALETTE.length]!;
    const x = b.x * scale;
    const y = b.y * scale;
    const w = b.width * scale;
    const h = b.height * scale;
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.strokeRect(x, y, w, h);
    const tw = g.measureText(b.label).width + 6;
    const ly = y - font - 4 >= 0 ? y - font - 4 : y;
    g.fillStyle = color;
    g.fillRect(x, ly, tw, font + 4);
    g.fillStyle = '#ffffff';
    g.fillText(b.label, x + 3, ly + 2);
  });
  return encode(canvas, format, quality);
}

export interface Tile {
  data: string;
  mimeType: string;
  caption: string;
}

/** Composes tiles into one grid image with a caption bar on each tile (storyboards). */
export async function compositeGrid(tiles: Tile[], columns: number, tileWidth: number, format: ImageFormat, quality: number): Promise<EncodedImage> {
  const bitmaps = await Promise.all(tiles.map((t) => decode(t.data, t.mimeType)));
  const aspect = bitmaps.length ? bitmaps[0]!.height / bitmaps[0]!.width : 9 / 16;
  const tileHeight = Math.round(tileWidth * aspect);
  const gap = 4;
  const rows = Math.ceil(tiles.length / columns);
  const canvas = new OffscreenCanvas(columns * tileWidth + (columns + 1) * gap, rows * tileHeight + (rows + 1) * gap);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#111827';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const font = Math.max(11, Math.round(tileWidth / 20));
  g.font = `bold ${font}px sans-serif`;
  g.textBaseline = 'top';
  bitmaps.forEach((bmp, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = gap + col * (tileWidth + gap);
    const y = gap + row * (tileHeight + gap);
    g.drawImage(bmp, x, y, tileWidth, tileHeight);
    bmp.close();
    const caption = tiles[i]!.caption;
    const tw = g.measureText(caption).width + 8;
    g.fillStyle = 'rgba(0,0,0,0.72)';
    g.fillRect(x, y, tw, font + 6);
    g.fillStyle = '#fde047';
    g.fillText(caption, x + 4, y + 3);
  });
  return encode(canvas, format, quality);
}

/** Mean luminance 0-255 of an image (used to detect DRM-black frames). */
export async function meanLuminance(data: string, mimeType: string): Promise<number> {
  const bitmap = await decode(data, mimeType);
  const w = 32;
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * 32));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const px = g.getImageData(0, 0, w, h).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
  return sum / (px.length / 4);
}

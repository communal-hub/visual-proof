import fs from 'node:fs';
import sharp from 'sharp';
import { imageState } from './client.js';

/** Decode guards, before allocating image pixels or encoding base64. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_IMAGE_PARTS = 128;
export const MAX_STATE_IMAGE_BYTES = 64 * 1024 * 1024;

/** Jev rejects an image with a side above this ("Invalid image dimensions"; measured 2026-10-14: 1568 ok, 1569 not). */
export const MAX_IMAGE_SIDE = 1568;
/** ... or with a side below roughly this (256 rejected, 280 accepted); smaller images are padded up to it. */
export const MIN_IMAGE_SIDE = 280;

/** Preserve readable viewport detail and page context without sending an unbounded full-page image. */
export async function prepareImage(file: string): Promise<unknown[]> {
  if (fs.statSync(file).size > MAX_IMAGE_BYTES) throw new Error(`image payload exceeds ${MAX_IMAGE_BYTES} bytes`);
  const png = fs.readFileSync(file);
  const image = sharp(png, { limitInputPixels: MAX_IMAGE_PIXELS });
  const { width, height, format } = await image.metadata();
  if (format !== 'png' || !width || !height) throw new Error('expected a valid PNG screenshot');
  if (width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE) return imageState(await padToMinimum(png, width, height));
  const full = await image.clone().resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  const top = await image.clone().extract({ left: 0, top: 0, width, height: Math.min(height, 800) })
    .resize({ width: Math.min(width, 1280), withoutEnlargement: true }).png().toBuffer();
  return [
    'Top of viewport (readable detail):',
    ...imageState(await padToMinimum(top)),
    'Resized full page (context):',
    ...imageState(await padToMinimum(full)),
  ];
}

/** Pad a side shorter than {@link MIN_IMAGE_SIDE} with white, keeping the content at the top left. */
export async function padToMinimum(png: Buffer, width?: number, height?: number): Promise<Buffer> {
  if (width === undefined || height === undefined) ({ width, height } = await sharp(png).metadata());
  if (!width || !height || (width >= MIN_IMAGE_SIDE && height >= MIN_IMAGE_SIDE)) return png;
  return sharp(png)
    .extend({ right: Math.max(0, MIN_IMAGE_SIDE - width), bottom: Math.max(0, MIN_IMAGE_SIDE - height), background: '#ffffff' })
    .png()
    .toBuffer();
}

/** A white PNG Jev accepts: the cheapest image that still goes through image encoding (doctor's probe). */
export function probeImage(): Promise<Buffer> {
  return sharp({ create: { width: MIN_IMAGE_SIDE, height: MIN_IMAGE_SIDE, channels: 3, background: '#ffffff' } }).png().toBuffer();
}

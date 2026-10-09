import fs from 'node:fs';
import sharp from 'sharp';
import { imageState } from './client.js';

/** Decode guards, before allocating image pixels or encoding base64. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_IMAGE_PARTS = 128;
export const MAX_STATE_IMAGE_BYTES = 64 * 1024 * 1024;

/** Preserve readable viewport detail and page context without sending an unbounded full-page image. */
export async function prepareImage(file: string): Promise<unknown[]> {
  if (fs.statSync(file).size > MAX_IMAGE_BYTES) throw new Error(`image payload exceeds ${MAX_IMAGE_BYTES} bytes`);
  const png = fs.readFileSync(file);
  const image = sharp(png, { limitInputPixels: MAX_IMAGE_PIXELS });
  const { width, height, format } = await image.metadata();
  if (format !== 'png' || !width || !height) throw new Error('expected a valid PNG screenshot');
  if (width <= 1280 && height <= 1600) return imageState(png);
  const full = await image.clone().resize({ width: 1280, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  const top = await image.clone().extract({ left: 0, top: 0, width, height: Math.min(height, 800) })
    .resize({ width: 1280, withoutEnlargement: true }).png().toBuffer();
  return ['Top of viewport (readable detail):', ...imageState(top), 'Resized full page (context):', ...imageState(full)];
}

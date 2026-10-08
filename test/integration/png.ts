import zlib from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, row-major. */
  pixels: Uint8Array;
  pixel(x: number, y: number): [number, number, number];
}

/** Dimensions from the IHDR chunk; no decoding. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.subarray(1, 4).toString() !== 'PNG') throw new Error('not a PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Minimal decoder for what Chromium writes: 8-bit RGB or RGBA, non-interlaced. */
export function decodePng(png: Buffer): DecodedPng {
  const { width, height } = pngSize(png);
  const bitDepth = png[24];
  const colorType = png[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || png[28] !== 0) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, color type ${colorType}, interlace ${png[28]})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= channels ? data[y * stride + i - channels]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels]! : 0;
      let value: number;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      data[y * stride + i] = value & 0xff;
    }
  }
  return {
    width,
    height,
    pixels: data,
    pixel: (x, y) => {
      const at = y * stride + x * channels;
      return [data[at]!, data[at + 1]!, data[at + 2]!];
    },
  };
}

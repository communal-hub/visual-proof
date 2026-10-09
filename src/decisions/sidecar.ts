import fs from 'node:fs';
import path from 'node:path';

/** Characters of app-root text kept per frame for the claim check. */
export const SIDECAR_TEXT_LIMIT = 8192;

const SUFFIX = '.text.json';

/** `frames/f-000042.png` -> `frames/f-000042.text.json`: the text sidecar of a frame's PNG. */
export function textSidecarPath(pngPath: string): string {
  return pngPath.replace(/\.png$/i, '') + SUFFIX;
}

/**
 * Keep the app root's visible text next to the frame's PNG (not in `index.jsonl`, which is read on every append).
 * Best effort: a frame without a sidecar only means the claim check has no text for it.
 */
export function writeTextSidecar(pngPath: string, text: string): void {
  const file = textSidecarPath(pngPath);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, text: text.slice(0, SIDECAR_TEXT_LIMIT) })}\n`);
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    return;
  }
  sweepOrphanSidecars(path.dirname(pngPath));
}

/** The text kept for a frame, or null when there is no readable sidecar (older frames, a failed write). */
export function readTextSidecar(pngPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(textSidecarPath(pngPath), 'utf8'));
    const text = (parsed as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** Sidecars whose PNG the timeline evicted: delete them (the timeline only knows about PNGs). */
export function sweepOrphanSidecars(framesDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(framesDir);
  } catch {
    return;
  }
  const pngs = new Set(names.filter((n) => n.endsWith('.png')));
  for (const name of names) {
    if (!name.endsWith(SUFFIX)) continue;
    if (!pngs.has(`${name.slice(0, -SUFFIX.length)}.png`)) fs.rmSync(path.join(framesDir, name), { force: true });
  }
}

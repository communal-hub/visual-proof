import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildReplay,
  captionText,
  clockTime,
  estimateMs,
  filterScript,
  pngSize,
  replayCanvas,
  resetFfmpegProbes,
  selectReplayFrames,
} from '../../src/replay.js';
import type { Frame } from '../../src/timeline.js';
import { tmpDir } from './helpers.js';

const frame = (n: number, extra: Partial<Frame> = {}): Frame => ({
  id: `f-${String(n).padStart(6, '0')}`,
  sessionId: 's',
  route: '/r',
  routeKey: '/r',
  at: new Date(Date.UTC(2026, 9, 8, 12, 3, 40 + n)).toISOString(),
  treeHash: 't',
  trigger: 'screen',
  status: 'clean',
  reasons: [],
  png: `frames/f-${n}.png`,
  ...extra,
});

/** A PNG header with the given size (enough for pngSize; not a decodable image). */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe('selectReplayFrames', () => {
  it('keeps the latest N frames that have a PNG, oldest first', () => {
    const frames = [1, 2, 3, 4, 5, 6].map((n) => frame(n));
    const picked = selectReplayFrames(frames, (f) => f.id !== 'f-000005', 3);
    expect(picked.map((f) => f.id)).toEqual(['f-000003', 'f-000004', 'f-000006']);
    expect(selectReplayFrames(frames, () => true, 100)).toHaveLength(6);
    expect(selectReplayFrames([], () => true, 3)).toEqual([]);
  });
});

describe('captions', () => {
  it('clockTime is HH:MM:SS in UTC', () => {
    expect(clockTime('2026-10-08T12:03:41.500Z')).toBe('12:03:41');
    expect(clockTime('nonsense')).toBe('--:--:--');
  });

  it('a route frame: route, source file, time; a non-clean status is flagged', () => {
    expect(captionText(frame(1, { route: '/manage/invoices/1', sourceFile: 'src/pages/InvoiceDetail.vue' }))).toBe(
      '/manage/invoices/1   |   src/pages/InvoiceDetail.vue   |   12:03:41',
    );
    expect(captionText(frame(2, { status: 'error' }))).toBe('/r [error]   |   12:03:42');
  });

  it('a sidecar frame names the scenario and the still', () => {
    const text = captionText(frame(3, { route: 'sidecar:.visual-proof/sidecars/refund.vp#refund-modal', sourceFile: '.visual-proof/sidecars/refund.vp' }));
    expect(text).toBe('sidecar refund / refund-modal   |   .visual-proof/sidecars/refund.vp   |   12:03:43');
  });

  it('replaces characters a caption font may lack', () => {
    expect(captionText(frame(1, { route: '/café\n' }))).toBe('/caf??   |   12:03:41');
  });
});

describe('canvas and filter chain', () => {
  it('reads PNG sizes from the header', () => {
    const dir = tmpDir('vp-png-');
    fs.writeFileSync(path.join(dir, 'a.png'), pngHeader(1280, 2345));
    fs.writeFileSync(path.join(dir, 'b.png'), 'not a png at all, but long enough to read 24 bytes');
    expect(pngSize(path.join(dir, 'a.png'))).toEqual({ width: 1280, height: 2345 });
    expect(pngSize(path.join(dir, 'b.png'))).toBeNull();
    expect(pngSize(path.join(dir, 'missing.png'))).toBeNull();
  });

  it('width = viewport width, height = tallest frame capped at maxHeight, both even', () => {
    const viewport = { width: 1281, height: 800 };
    expect(replayCanvas([{ width: 1281, height: 2100 }], viewport, 1600)).toEqual({ width: 1280, height: 1600 });
    expect(replayCanvas([{ width: 1281, height: 1001 }, null], viewport, 1600)).toEqual({ width: 1280, height: 1000 });
    expect(replayCanvas([], viewport, 1600)).toEqual({ width: 1280, height: 800 });
    expect(replayCanvas([{ width: 1280, height: 5000 }], viewport, 99)).toEqual({ width: 1280, height: 98 });
  });

  it('scales to fit, pads onto the canvas, and ends in yuv420p, with no fps filter', () => {
    const script = filterScript({ canvas: { width: 1280, height: 1600 } });
    expect(script).toBe(
      'scale=1280:1600:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:1600:(ow-iw)/2:0:color=0x202020,format=yuv420p',
    );
    expect(script).not.toContain('fps=');
    expect(script).not.toContain('drawtext');
  });

  it('with captions: a bar under the canvas and one drawtext per frame, each live for its own half-frame window', () => {
    const script = filterScript({
      canvas: { width: 1280, height: 800 },
      captions: ['/tmp/w/caption-0.txt', '/tmp/w/caption-1.txt'],
      secondsPerFrame: 1.2,
      fontfile: '/fonts/a:b.ttf',
    });
    expect(script).toContain('pad=1280:836:');
    expect(script).toContain('drawbox=x=0:y=800:w=1280:h=36');
    expect(script.match(/drawtext=/g)).toHaveLength(2);
    expect(script).toContain('textfile=/tmp/w/caption-0.txt');
    expect(script).toContain("enable='gte(t,-0.6000)*lt(t,0.6000)'");
    expect(script).toContain("enable='gte(t,0.6000)*lt(t,1.8000)'");
    expect(script).toContain('fontfile=/fonts/a\\:b.ttf');
    expect(script).toContain('expansion=none');
  });
});

// ---- buildReplay against a fake ffmpeg ------------------------------------------------------

const FAKE = `#!/bin/bash
case "$*" in
  *-version*) echo "ffmpeg version 0.0-fake Copyright";;
  *-encoders*) [ -z "$FAKE_NO_X264" ] && echo " V....D libx264              libx264 H.264";;
  *-filters*) [ -z "$FAKE_NO_DRAWTEXT" ] && echo " T.C drawtext          V->V       Draw text";;
  *lavfi*) exit 0;;
  *)
    echo "$@" > "$FAKE_ARGS"
    [ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
    [ -n "$FAKE_FAIL" ] && { echo "Error: boom, bad filter" >&2; exit 1; }
    for last; do :; done
    echo fake-mp4 > "$last"
    ;;
esac
`;

let dir: string;
let artifactDir: string;
let scratchDir: string;
let pngs: string;
let binDir: string;
let argsFile: string;

beforeEach(() => {
  resetFfmpegProbes();
  dir = tmpDir('vp-replay-');
  artifactDir = path.join(dir, 'artifacts');
  scratchDir = path.join(dir, 'scratch');
  pngs = path.join(dir, 'pngs');
  binDir = path.join(dir, 'bin');
  argsFile = path.join(dir, 'args.txt');
  for (const d of [artifactDir, scratchDir, pngs, binDir]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(binDir, 'ffmpeg'), FAKE, { mode: 0o755 });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: `${binDir}:/bin:/usr/bin`, FAKE_ARGS: argsFile, ...extra });

function frames(n: number): Frame[] {
  return Array.from({ length: n }, (_, i) => {
    const f = frame(i + 1);
    fs.writeFileSync(path.join(pngs, `${f.id}.png`), pngHeader(1280, 800 + i * 100));
    return f;
  });
}

const build = (list: Frame[], extra: Partial<Parameters<typeof buildReplay>[0]> = {}) =>
  buildReplay({
    frames: list,
    pngPath: (f) => path.join(pngs, `${f.id}.png`),
    config: { viewport: { width: 1280, height: 800 }, replay: { enabled: true, maxFrames: 60, secondsPerFrame: 1.2, maxHeight: 1600 } },
    artifactDir,
    scratchDir,
    shortTree: 'abcd1234',
    env: env(),
    remainingMs: 20_000,
    ...extra,
  });

describe('buildReplay', () => {
  it('encodes H.264 yuv420p with faststart from a numbered image sequence, one frame per secondsPerFrame', async () => {
    const outcome = await build(frames(3));
    expect(outcome.notes).toEqual([]);
    expect(outcome.result).toMatchObject({ path: path.join(artifactDir, 'replay-abcd1234.mp4'), frames: 3, seconds: 3.6, captions: true });
    expect(fs.readFileSync(outcome.result!.path, 'utf8')).toBe('fake-mp4\n');

    const args = fs.readFileSync(argsFile, 'utf8').trim().split(' ');
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after('-framerate')).toBe('1/1.2');
    expect(after('-i')).toMatch(/%04d\.png$/);
    expect(after('-c:v')).toBe('libx264');
    expect(after('-pix_fmt')).toBe('yuv420p');
    expect(after('-movflags')).toBe('+faststart');
    expect(after('-r')).toBe('10');
    expect(after('-t')).toBe('3.6');
    expect(after('-vf')).toContain('drawtext=');
    expect(after('-vf')).toContain('pad=1280:1036:'); // tallest frame 1000 px + 36 px bar
    expect(fs.readdirSync(scratchDir)).toEqual([]); // the work dir is gone
  });

  it('keeps only the latest maxFrames', async () => {
    const outcome = await build(frames(5), {
      config: { viewport: { width: 1280, height: 800 }, replay: { enabled: true, maxFrames: 2, secondsPerFrame: 1, maxHeight: 1600 } },
    });
    expect(outcome.result).toMatchObject({ frames: 2, seconds: 2 });
    expect(fs.readFileSync(argsFile, 'utf8')).toContain('-t 2');
  });

  it('skips with a note when ffmpeg is not on PATH', async () => {
    const outcome = await build(frames(2), { env: { PATH: path.join(dir, 'nothing-here') } });
    expect(outcome).toEqual({ notes: ['replay skipped: ffmpeg not found'] });
  });

  it('skips when there is no libx264', async () => {
    const outcome = await build(frames(2), { env: env({ FAKE_NO_X264: '1' }) });
    expect(outcome).toEqual({ notes: ['replay skipped: this ffmpeg has no libx264 encoder'] });
  });

  it('without drawtext it builds without captions and notes it', async () => {
    const outcome = await build(frames(2), { env: env({ FAKE_NO_DRAWTEXT: '1' }) });
    expect(outcome.result).toMatchObject({ frames: 2, captions: false });
    expect(outcome.notes).toEqual(['replay built without captions: this ffmpeg has no drawtext filter (built without libfreetype)']);
    const args = fs.readFileSync(argsFile, 'utf8');
    expect(args).not.toContain('drawtext');
    expect(args).toContain('pad=1280:900:');
  });

  it('notes when no frame has a screenshot', async () => {
    expect((await build([])).notes).toEqual(['replay skipped: no frames with a screenshot in this session']);
    const list = frames(2);
    fs.rmSync(path.join(pngs, `${list[0]!.id}.png`));
    fs.rmSync(path.join(pngs, `${list[1]!.id}.png`));
    expect((await build(list)).notes).toEqual(['replay skipped: no frames with a screenshot in this session']);
  });

  it('skips up front when the remaining budget cannot fit the build', async () => {
    const outcome = await build(frames(3), { remainingMs: 100 });
    expect(outcome.result).toBeUndefined();
    expect(outcome.notes).toEqual([`replay skipped: 100 ms of the finish budget left, about ${estimateMs(3)} ms needed for 3 frame(s)`]);
    expect(fs.existsSync(argsFile)).toBe(false); // the encode never started
  });

  it('kills ffmpeg that overruns the remaining budget, and leaves no video behind', async () => {
    const t0 = Date.now();
    const outcome = await build(frames(2), { env: env({ FAKE_SLEEP: '10' }), remainingMs: 1500 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(outcome.result).toBeUndefined();
    expect(outcome.notes).toEqual(['replay skipped: ffmpeg did not finish within the 1500 ms of finish budget left']);
    expect(fs.readdirSync(artifactDir)).toEqual([]);
    expect(fs.readdirSync(scratchDir)).toEqual([]);
  });

  it('a failing encode is a note with ffmpeg\'s last line, never a throw', async () => {
    const outcome = await build(frames(2), { env: env({ FAKE_FAIL: '1' }) });
    expect(outcome.result).toBeUndefined();
    expect(outcome.notes).toEqual(['replay failed: Error: boom, bad filter']);
    expect(fs.readdirSync(artifactDir)).toEqual([]);
  });
});

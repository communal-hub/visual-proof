import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { parseSidecarRoute, sidecarName } from './sidecar.js';
import type { Frame } from './timeline.js';

/**
 * The replay video (A3 compositor): the session's frames in the order they were captured, each shown for a
 * moment on a fixed canvas, with a caption bar. Built with ffmpeg when it is on PATH; never a failure when
 * it is not.
 */

/** Height of the caption bar under the stills (px). */
export const CAPTION_BAR = 36;
/** Output frame rate. Stills are static, so a low rate keeps the encode quick and the file small. */
export const REPLAY_FPS = 10;

export interface FfmpegInfo {
  found: boolean;
  version?: string;
  /** The `drawtext` filter works (it needs libfreetype and a font). */
  drawtext: boolean;
  /** A font file drawtext needs when ffmpeg has no fontconfig default. */
  fontfile?: string;
  /** libx264 is available: the only encoder the replay uses (H.264 plays inline everywhere). */
  x264: boolean;
  /** Why something is missing, for notes and doctor. */
  reason?: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawning failed (`ENOENT`: no such command) or the run was killed (`timeout`). */
  error?: string;
}

const OUTPUT_CAP = 256 * 1024;

/** Run a command without a shell; stdout/stderr are kept (capped). */
export function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { env: options.env ?? process.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout, stderr, error: (err as NodeJS.ErrnoException).code ?? 'spawn failed' });
      return;
    }
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // Do not wait for the pipes to close: a grandchild holding them open must not outlive the budget.
      finish({ code: null, stdout, stderr, error: 'timeout' });
    }, options.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, error: err.code ?? err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, ...(timedOut ? { error: 'timeout' } : {}) }));
  });
}

/** Fonts tried for drawtext when ffmpeg has no default (no fontconfig). */
const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
];

const probes = new Map<string, Promise<FfmpegInfo>>();

/** What ffmpeg (as found through `env.PATH`) can do. Cached per PATH for the life of the process. */
export function probeFfmpeg(env: NodeJS.ProcessEnv = process.env): Promise<FfmpegInfo> {
  const key = env.PATH ?? '';
  let probe = probes.get(key);
  if (!probe) probes.set(key, (probe = doProbe(env)));
  return probe;
}

/** Forget cached probes (tests change PATH or fake binaries). */
export function resetFfmpegProbes(): void {
  probes.clear();
}

async function doProbe(env: NodeJS.ProcessEnv): Promise<FfmpegInfo> {
  const version = await run('ffmpeg', ['-hide_banner', '-version'], { env, timeoutMs: 10_000 });
  if (version.error === 'ENOENT') return { found: false, drawtext: false, x264: false, reason: 'ffmpeg not found' };
  if (version.code !== 0) {
    return { found: false, drawtext: false, x264: false, reason: `ffmpeg did not run (${version.error ?? `exit ${version.code}`})` };
  }
  const info: FfmpegInfo = {
    found: true,
    version: /ffmpeg version (\S+)/.exec(version.stdout)?.[1] ?? 'unknown',
    drawtext: false,
    x264: false,
  };

  const encoders = await run('ffmpeg', ['-hide_banner', '-encoders'], { env, timeoutMs: 10_000 });
  info.x264 = /\blibx264\b/.test(encoders.stdout);

  const filters = await run('ffmpeg', ['-hide_banner', '-filters'], { env, timeoutMs: 10_000 });
  if (!/\bdrawtext\b/.test(filters.stdout)) {
    info.reason = 'this ffmpeg has no drawtext filter (built without libfreetype)';
    return info;
  }
  // The filter existing is not enough: it needs a font, from fontconfig or a file.
  if (await drawtextWorks(env)) {
    info.drawtext = true;
    return info;
  }
  for (const font of FONT_CANDIDATES) {
    if (!fs.existsSync(font)) continue;
    if (await drawtextWorks(env, font)) {
      info.drawtext = true;
      info.fontfile = font;
      return info;
    }
  }
  info.reason = 'drawtext has no usable font (no fontconfig default and none of the common font files exists)';
  return info;
}

async function drawtextWorks(env: NodeJS.ProcessEnv, fontfile?: string): Promise<boolean> {
  const filter = `drawtext=text=x${fontfile ? `:fontfile=${escapeFilterValue(fontfile)}` : ''}`;
  const result = await run(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x32:d=0.1', '-vf', filter, '-frames:v', '1', '-f', 'null', '-'],
    { env, timeoutMs: 10_000 },
  );
  return result.code === 0;
}

/** Escape a value inside a filtergraph (`\`, `:` and `'` are special). */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// ---- frames and captions -----------------------------------------------------------

/** The latest `max` frames whose PNG exists, oldest first (the order they were captured in). */
export function selectReplayFrames(frames: Frame[], hasPng: (frame: Frame) => boolean, max: number): Frame[] {
  return frames.filter(hasPng).slice(-max);
}

/** `HH:MM:SS` (UTC) of an ISO timestamp. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toISOString().slice(11, 19);
}

/** What the caption bar says about a frame: the route or the scenario and still, its source file, and when. */
export function captionText(frame: Pick<Frame, 'route' | 'sourceFile' | 'at' | 'status'>): string {
  const sidecar = parseSidecarRoute(frame.route);
  const label = sidecar ? `sidecar ${sidecarName(sidecar.file)} / ${sidecar.still}` : frame.route;
  const parts = [label];
  if (frame.status !== 'clean') parts[0] += ` [${frame.status}]`;
  if (frame.sourceFile) parts.push(frame.sourceFile);
  parts.push(clockTime(frame.at));
  // Control characters and anything a bitmap font may lack must not break the filter or draw boxes.
  return parts.join('   |   ').replace(/[^\x20-\x7e]/g, '?');
}

/** Width and height from a PNG's IHDR chunk, or null for anything else. */
export function pngSize(file: string): { width: number; height: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24) return null;
    if (head.readUInt32BE(0) !== 0x89504e47 || head.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

export interface Canvas {
  width: number;
  /** Height of the picture area; the caption bar is added below it. */
  height: number;
}

/** Width = viewport width; height = the tallest frame, capped at `maxHeight`. Both even (yuv420p). */
export function replayCanvas(sizes: Array<{ width: number; height: number } | null>, viewport: { width: number; height: number }, maxHeight: number): Canvas {
  const tallest = Math.max(viewport.height, ...sizes.map((s) => s?.height ?? 0));
  return { width: even(viewport.width), height: even(Math.min(tallest, maxHeight)) };
}

export interface FilterScriptInput {
  canvas: Canvas;
  /** One caption text file per frame, in order; omit to build without the caption bar. */
  captions?: string[];
  /** Seconds each frame is shown (captions switch at the midpoints between frame timestamps). */
  secondsPerFrame?: number;
  fontfile?: string;
}

/**
 * The video filter chain: scale each frame to fit the canvas (never enlarging past it), pad it onto the canvas
 * top-aligned, then draw the caption bar and each frame's caption while it is on screen.
 */
export function filterScript({ canvas, captions, fontfile, secondsPerFrame = 1 }: FilterScriptInput): string {
  const { width, height } = canvas;
  const total = captions ? height + CAPTION_BAR : height;
  const chain = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${total}:(ow-iw)/2:0:color=0x202020`,
  ];
  if (captions) {
    chain.push(`drawbox=x=0:y=${height}:w=${width}:h=${CAPTION_BAR}:color=0x101418:t=fill`);
    captions.forEach((file, i) => {
      const font = fontfile ? `fontfile=${escapeFilterValue(fontfile)}:` : '';
      // Frame i arrives at t = i * secondsPerFrame (one source frame per image, repeated later by the output rate);
      // the half-frame margins keep a timestamp rounding either way from showing two captions or none.
      const from = ((i - 0.5) * secondsPerFrame).toFixed(4);
      const to = ((i + 0.5) * secondsPerFrame).toFixed(4);
      chain.push(
        `drawtext=${font}textfile=${escapeFilterValue(file)}:expansion=none:fontcolor=white:fontsize=16:x=12:y=${height}+(${CAPTION_BAR}-text_h)/2:enable='gte(t,${from})*lt(t,${to})'`,
      );
    });
  }
  // No fps filter: a frame size change reinitialises the graph and drops the frame the filter was holding.
  // The output rate (-r) does the repeating instead.
  chain.push('format=yuv420p');
  return chain.join(',');
}

// ---- building ----------------------------------------------------------------------

export interface ReplayResult {
  /** Absolute path of the mp4 in the artifact dir. */
  path: string;
  frames: number;
  /** Length of the video. */
  seconds: number;
  /** False when ffmpeg could not draw captions. */
  captions: boolean;
  /** How long ffmpeg ran. */
  ms: number;
}

export interface BuildReplayOptions {
  /** This session's frames, oldest first. */
  frames: Frame[];
  /** Absolute path of a frame's PNG. */
  pngPath: (frame: Frame) => string;
  config: Pick<Config, 'viewport' | 'replay'>;
  artifactDir: string;
  /** Throwaway files (the numbered image links and the captions) go here, in their own directory. */
  scratchDir: string;
  shortTree: string;
  env?: NodeJS.ProcessEnv;
  /** Finish budget left. The build is skipped when it cannot fit, and ffmpeg is killed when it overruns. */
  remainingMs: number;
}

export interface BuildReplayOutcome {
  result?: ReplayResult;
  /** One-line notes for the proof block: why it was skipped, or what is missing from it. */
  notes: string[];
}

/** Rough cost of an encode: a startup plus a little per frame shown. */
export function estimateMs(frames: number): number {
  return 600 + frames * 40;
}

/** Build `replay-<shortTree>.mp4` in the artifact dir. Never throws: every problem is a note. */
export async function buildReplay(options: BuildReplayOptions): Promise<BuildReplayOutcome> {
  const notes: string[] = [];
  try {
    const env = options.env ?? process.env;
    const info = await probeFfmpeg(env);
    if (!info.found) return { notes: [`replay skipped: ${info.reason ?? 'ffmpeg not found'}`] };
    if (!info.x264) return { notes: ['replay skipped: this ffmpeg has no libx264 encoder'] };

    const { replay, viewport } = options.config;
    const frames = selectReplayFrames(options.frames, (f) => fs.existsSync(options.pngPath(f)), replay.maxFrames);
    if (frames.length === 0) return { notes: ['replay skipped: no frames with a screenshot in this session'] };

    const needMs = estimateMs(frames.length);
    if (options.remainingMs < needMs) {
      return { notes: [`replay skipped: ${Math.max(0, Math.round(options.remainingMs))} ms of the finish budget left, about ${needMs} ms needed for ${frames.length} frame(s)`] };
    }

    const captions = info.drawtext;
    if (!captions) notes.push(`replay built without captions: ${info.reason ?? 'drawtext is unavailable'}`);

    const work = path.join(options.scratchDir, `replay-${process.pid}-${Date.now().toString(36)}`);
    fs.mkdirSync(work, { recursive: true });
    const out = path.join(options.artifactDir, `replay-${options.shortTree}.mp4`);
    const part = path.join(work, 'out.mp4');
    try {
      const pngs = frames.map((f) => options.pngPath(f));
      const canvas = replayCanvas(pngs.map(pngSize), viewport, replay.maxHeight);
      const captionFiles = captions
        ? frames.map((frame, i) => {
            const file = path.join(work, `caption-${i}.txt`);
            fs.writeFileSync(file, captionText(frame));
            return file;
          })
        : undefined;
      // An image sequence at one frame per `secondsPerFrame`: every image gets exactly that long, the last one included
      // (the concat demuxer drops or stretches the final entry depending on the frame sizes).
      pngs.forEach((png, i) => {
        const link = path.join(work, `${String(i).padStart(4, '0')}.png`);
        try {
          fs.symlinkSync(png, link);
        } catch {
          fs.copyFileSync(png, link);
        }
      });

      const totalSeconds = Math.round(frames.length * replay.secondsPerFrame * 1000) / 1000;
      const started = Date.now();
      const result = await run(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-framerate', `1/${replay.secondsPerFrame}`, '-i', path.join(work, '%04d.png'),
          // Inline, not a script file: `-filter_script` was removed from recent ffmpeg and `-/filter` is missing from older ones.
          '-vf', filterScript({ canvas, captions: captionFiles, fontfile: info.fontfile, secondsPerFrame: replay.secondsPerFrame }),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-pix_fmt', 'yuv420p', '-r', String(REPLAY_FPS), '-t', String(totalSeconds),
          '-movflags', '+faststart',
          part,
        ],
        { env, timeoutMs: Math.max(500, options.remainingMs - 250) },
      );
      const ms = Date.now() - started;
      if (result.error === 'timeout') {
        notes.push(`replay skipped: ffmpeg did not finish within the ${Math.round(options.remainingMs)} ms of finish budget left`);
        return { notes };
      }
      if (result.code !== 0 || !fs.existsSync(part)) {
        const why = result.stderr.trim().split('\n').filter(Boolean).at(-1) ?? result.error ?? `exit ${result.code}`;
        notes.push(`replay failed: ${why}`);
        return { notes };
      }
      fs.mkdirSync(options.artifactDir, { recursive: true });
      fs.copyFileSync(part, out);
      return {
        result: { path: out, frames: frames.length, seconds: totalSeconds, captions, ms },
        notes,
      };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  } catch (err) {
    notes.push(`replay failed: ${(err as Error).message.split('\n')[0]}`);
    return { notes };
  }
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { readClip, resampleClip, type ClipManifest } from './motion.js';
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
/** Output frame rate when the replay has motion clips (v0.9): smooth enough for a gliding cursor. */
export const MOTION_FPS = 25;
/** At most this much motion (ms) goes into one replay; older clips beyond it show as their stills. */
export const MAX_MOTION_MS = 120_000;

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

/** A caption text file and the seconds of output it shows for. */
export interface CaptionWindow {
  file: string;
  from: number;
  to: number;
}

export interface FilterScriptInput {
  canvas: Canvas;
  /** One caption text file per frame, in order; omit to build without the caption bar. */
  captions?: string[];
  /** Captions by time instead of per frame (motion clips); used when `captions` is absent. */
  windows?: CaptionWindow[];
  /** Seconds each frame is shown (captions switch at the midpoints between frame timestamps). */
  secondsPerFrame?: number;
  fontfile?: string;
}

/**
 * The video filter chain: scale each frame to fit the canvas (never enlarging past it), pad it onto the canvas
 * top-aligned, then draw the caption bar and each frame's caption while it is on screen.
 */
export function filterScript({ canvas, captions, windows, fontfile, secondsPerFrame = 1 }: FilterScriptInput): string {
  const { width, height } = canvas;
  // Frame i arrives at t = i * secondsPerFrame (one source frame per image, repeated later by the output rate);
  // the half-frame margins keep a timestamp rounding either way from showing two captions or none.
  const timed = captions
    ? captions.map((file, i) => ({ file, from: (i - 0.5) * secondsPerFrame, to: (i + 0.5) * secondsPerFrame }))
    : windows;
  const total = timed ? height + CAPTION_BAR : height;
  const chain = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${total}:(ow-iw)/2:0:color=0x202020`,
  ];
  if (timed) {
    chain.push(`drawbox=x=0:y=${height}:w=${width}:h=${CAPTION_BAR}:color=0x101418:t=fill`);
    for (const { file, from, to } of timed) {
      const font = fontfile ? `fontfile=${escapeFilterValue(fontfile)}:` : '';
      chain.push(
        `drawtext=${font}textfile=${escapeFilterValue(file)}:expansion=none:fontcolor=white:fontsize=16:x=12:y=${height}+(${CAPTION_BAR}-text_h)/2:enable='gte(t,${from.toFixed(4)})*lt(t,${to.toFixed(4)})'`,
      );
    }
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
  /** Motion clips in the video (v0.9); 0 when it is stills only. */
  clips: number;
  /** How long ffmpeg ran. */
  ms: number;
}

export interface BuildReplayOptions {
  /** This session's frames, oldest first. */
  frames: Frame[];
  /** Absolute path of a frame's PNG. */
  pngPath: (frame: Frame) => string;
  /** Absolute path of a frame's motion clip directory, if it has one (v0.9). */
  clipDir?: (frame: Frame) => string | undefined;
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

    const captionsOk = info.drawtext;
    if (replay.motion && options.clipDir) {
      const segments = planSegments(frames, clipLoader(options.clipDir), MAX_MOTION_MS);
      if (segments.some((s) => s.kind === 'clip')) {
        const motionMs = estimateMotionMs(segments, replay.secondsPerFrame);
        if (options.remainingMs >= motionMs) {
          if (!captionsOk) notes.push(`replay built without captions: ${info.reason ?? 'drawtext is unavailable'}`);
          const outcome = await buildMotion(options, info, segments, frames.length, captionsOk);
          return { ...outcome, notes: [...notes, ...outcome.notes] };
        }
        notes.push(`replay shows stills only: about ${motionMs} ms needed for its motion clips, ${Math.max(0, Math.round(options.remainingMs))} ms of the finish budget left`);
      }
    }

    const needMs = estimateMs(frames.length);
    if (options.remainingMs < needMs) {
      return { notes: [...notes, `replay skipped: ${Math.max(0, Math.round(options.remainingMs))} ms of the finish budget left, about ${needMs} ms needed for ${frames.length} frame(s)`] };
    }

    const captions = captionsOk;
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
        result: { path: out, frames: frames.length, seconds: totalSeconds, captions, clips: 0, ms },
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

// ---- motion clips (v0.9) -------------------------------------------------------------

/** A stretch of the replay: consecutive stills, or one recorded scenario run in place of its stills. */
export type ReplaySegment =
  | { kind: 'stills'; frames: Frame[] }
  | { kind: 'clip'; dir: string; manifest: ClipManifest; frames: Frame[] };

type ClipOf = (frame: Frame) => { dir: string; manifest: ClipManifest } | null;

/** Reads each clip's manifest once. */
function clipLoader(clipDir: (frame: Frame) => string | undefined): ClipOf {
  const cache = new Map<string, ClipManifest | null>();
  return (frame) => {
    const dir = clipDir(frame);
    if (!dir) return null;
    if (!cache.has(dir)) cache.set(dir, readClip(dir));
    const manifest = cache.get(dir);
    return manifest ? { dir, manifest } : null;
  };
}

/**
 * The replay in order: a recorded run replaces its stills, shown where its first still was; everything else stays a
 * still. The newest clips win when together they would run past `maxMotionMs` (one clip is always allowed); the
 * stills of the older ones show as stills.
 */
export function planSegments(frames: Frame[], clipOf: ClipOf, maxMotionMs: number): ReplaySegment[] {
  const clips = new Map<string, { dir: string; manifest: ClipManifest; last: number }>();
  frames.forEach((frame, i) => {
    const clip = clipOf(frame);
    if (clip) clips.set(clip.dir, { ...clip, last: i });
  });
  const used = new Set<string>();
  let budget = maxMotionMs;
  for (const clip of [...clips.values()].sort((a, b) => b.last - a.last)) {
    if (used.size > 0 && clip.manifest.duration > budget) continue;
    used.add(clip.dir);
    budget -= clip.manifest.duration;
  }

  const segments: ReplaySegment[] = [];
  const emitted = new Map<string, Extract<ReplaySegment, { kind: 'clip' }>>();
  for (const frame of frames) {
    const clip = clipOf(frame);
    if (clip && used.has(clip.dir)) {
      const seen = emitted.get(clip.dir);
      if (seen) {
        seen.frames.push(frame);
        continue;
      }
      const segment = { kind: 'clip' as const, dir: clip.dir, manifest: clip.manifest, frames: [frame] };
      emitted.set(clip.dir, segment);
      segments.push(segment);
      continue;
    }
    const last = segments.at(-1);
    if (last?.kind === 'stills') last.frames.push(frame);
    else segments.push({ kind: 'stills', frames: [frame] });
  }
  return segments;
}

/** Rough cost of a motion replay: a startup per segment plus a little per output frame, and the final join. */
export function estimateMotionMs(segments: ReplaySegment[], secondsPerFrame: number): number {
  let outputFrames = 0;
  for (const segment of segments) {
    const seconds = segment.kind === 'clip' ? segment.manifest.duration / 1000 : segment.frames.length * secondsPerFrame;
    outputFrames += Math.round(seconds * MOTION_FPS);
  }
  return 400 + segments.length * 350 + outputFrames * 6;
}

/** The caption bar text of a clip caption: the scenario and the step, in characters any font has. */
export function clipCaptionText(text: string): string {
  return `sidecar ${text}`.replace(/[^\x20-\x7e]/g, '?');
}

/** Caption windows (seconds) from the captions of consecutive ticks at `fps`. */
export function tickWindows(captions: number[], fps: number): Array<{ caption: number; from: number; to: number }> {
  const windows: Array<{ caption: number; from: number; to: number }> = [];
  captions.forEach((caption, k) => {
    const last = windows.at(-1);
    if (last && last.caption === caption) last.to = (k + 0.5) / fps;
    else windows.push({ caption, from: (k - 0.5) / fps, to: (k + 0.5) / fps });
  });
  return windows.filter((w) => w.caption >= 0);
}

const ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(MOTION_FPS), '-video_track_timescale', String(MOTION_FPS * 512)];

/**
 * Encode every segment on the viewport canvas at {@link MOTION_FPS} (stills scaled to fit), then join them without
 * re-encoding. Same canvas, rate and encoder settings for every part is what lets the join copy the streams.
 */
async function buildMotion(options: BuildReplayOptions, info: FfmpegInfo, segments: ReplaySegment[], frameCount: number, captions: boolean): Promise<BuildReplayOutcome> {
  const notes: string[] = [];
  const env = options.env ?? process.env;
  const { replay, viewport } = options.config;
  const canvas: Canvas = { width: even(viewport.width), height: even(viewport.height) };
  const deadline = Date.now() + options.remainingMs;
  const left = (): number => deadline - Date.now() - 250;

  const work = path.join(options.scratchDir, `replay-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(work, { recursive: true });
  const out = path.join(options.artifactDir, `replay-${options.shortTree}.mp4`);
  const started = Date.now();
  let totalSeconds = 0;
  try {
    const parts: string[] = [];
    for (const [n, segment] of segments.entries()) {
      const dir = path.join(work, `seg-${n}`);
      fs.mkdirSync(dir);
      const part = path.join(work, `seg-${n}.mp4`);
      let input: string[];
      let filter: string;
      let seconds: number;
      if (segment.kind === 'stills') {
        segment.frames.forEach((frame, i) => link(options.pngPath(frame), path.join(dir, `${String(i).padStart(5, '0')}.png`)));
        const captionFiles = captions
          ? segment.frames.map((frame, i) => {
              const file = path.join(dir, `caption-${i}.txt`);
              fs.writeFileSync(file, captionText(frame));
              return file;
            })
          : undefined;
        seconds = Math.round(segment.frames.length * replay.secondsPerFrame * 1000) / 1000;
        input = ['-framerate', `1/${replay.secondsPerFrame}`, '-i', path.join(dir, '%05d.png')];
        filter = filterScript({ canvas, captions: captionFiles, fontfile: info.fontfile, secondsPerFrame: replay.secondsPerFrame });
      } else {
        const ticks = resampleClip(segment.manifest, MOTION_FPS);
        ticks.forEach((tick, k) => link(path.join(segment.dir, tick.file), path.join(dir, `${String(k).padStart(5, '0')}.jpg`)));
        const windows = captions
          ? tickWindows(
              ticks.map((t) => t.caption),
              MOTION_FPS,
            ).map((w, i) => {
              const file = path.join(dir, `caption-${i}.txt`);
              fs.writeFileSync(file, clipCaptionText(segment.manifest.captions[w.caption]!.text));
              return { file, from: w.from, to: w.to };
            })
          : undefined;
        // Without captions there is no bar here either: every part must have the same height.
        seconds = ticks.length / MOTION_FPS;
        input = ['-framerate', String(MOTION_FPS), '-i', path.join(dir, '%05d.jpg')];
        filter = filterScript({ canvas, windows, fontfile: info.fontfile });
      }
      if (left() <= 0) return { notes: [...notes, `replay skipped: ffmpeg did not finish within the ${Math.round(options.remainingMs)} ms of finish budget left`] };
      const result = await run(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-vf', filter, ...ENCODE_ARGS, '-t', String(seconds), part],
        { env, timeoutMs: Math.max(500, left()) },
      );
      const failed = encodeFailure(result, part, options.remainingMs);
      if (failed) return { notes: [...notes, failed] };
      parts.push(part);
      totalSeconds += seconds;
    }

    const list = path.join(work, 'parts.txt');
    fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'\n`).join(''));
    const joined = path.join(work, 'out.mp4');
    const result = await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', joined],
      { env, timeoutMs: Math.max(500, left()) },
    );
    const failed = encodeFailure(result, joined, options.remainingMs);
    if (failed) return { notes: [...notes, failed] };
    fs.mkdirSync(options.artifactDir, { recursive: true });
    fs.copyFileSync(joined, out);
    return {
      result: {
        path: out,
        frames: frameCount,
        seconds: Math.round(totalSeconds * 1000) / 1000,
        captions,
        clips: segments.filter((s) => s.kind === 'clip').length,
        ms: Date.now() - started,
      },
      notes,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function link(target: string, at: string): void {
  try {
    fs.symlinkSync(target, at);
  } catch {
    fs.copyFileSync(target, at);
  }
}

/** The note for an ffmpeg run that did not produce `file`, or null when it did. */
function encodeFailure(result: RunResult, file: string, budgetMs: number): string | null {
  if (result.error === 'timeout') return `replay skipped: ffmpeg did not finish within the ${Math.round(budgetMs)} ms of finish budget left`;
  if (result.code !== 0 || !fs.existsSync(file)) {
    const why = result.stderr.trim().split('\n').filter(Boolean).at(-1) ?? result.error ?? `exit ${result.code}`;
    return `replay failed: ${why}`;
  }
  return null;
}

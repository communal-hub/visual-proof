import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFinish, type FinishResult } from '../../src/finish.js';
import { probeFfmpeg, run } from '../../src/replay.js';
import { sidecarRoute } from '../../src/sidecar.js';
import { createHarness, type Harness } from './harness.js';

const ffmpeg = await probeFfmpeg();
const ffprobe = (await run('ffprobe', ['-version'], { timeoutMs: 10_000 })).code === 0;
const canEncode = ffmpeg.found && ffmpeg.x264 && ffprobe;
if (!canEncode) console.warn(`replay mp4 tests skipped: ffmpeg ${ffmpeg.found ? 'found' : 'not found'}, libx264 ${ffmpeg.x264}, ffprobe ${ffprobe}`);
if (canEncode && !ffmpeg.drawtext) console.warn(`replay caption test skipped: ${ffmpeg.reason}`);

const INTERACT = '/manage/interact';
let h: Harness;
let sessionFrames: number;
let tree: string;

beforeAll(async () => {
  h = await createHarness({ config: { replay: { motion: false } } }); // the stills replay; motion.test.ts covers clips
  await h.start();
  const modal = h.writeSidecar('modal', `goto ${INTERACT}\nclick [data-test=open-modal]\nwait [data-test=confirm-modal]\nstill modal-open\n`);
  const form = h.writeSidecar('form', `goto ${INTERACT}\nfill [data-test=name-input] "Ada"\nclick [data-test=next]\nstill step-2\n`);
  await h.waitForFrame((e) => e.frame.route === sidecarRoute(modal, 'modal-open'), 30_000, { from: 0 });
  await h.waitForFrame((e) => e.frame.route === sidecarRoute(form, 'step-2'), 30_000, { from: 0 });
  // Editing the page replays the page route and both scenarios: more frames for the video, all at the final tree.
  // The page and both scenarios arrive in one batch, so look back from before the edit.
  const from = h.frames.length;
  h.edit('src/pages/Interact.vue', (s) => s.replace('<h1>Interact</h1>', '<h1>Interact (replay)</h1>'));
  await h.waitForFrame((e) => e.frame.route === INTERACT && e.signals.text.includes('Interact (replay)'), 30_000, { from });
  await h.waitForFrame((e) => e.frame.route === sidecarRoute(form, 'step-2') && e.signals.text.includes('Interact (replay)'), 30_000, { from });
  tree = h.commitAll('interactions');
  sessionFrames = h.timeline().list({ sessionId: h.watch!.sessionId }).length;
});
afterAll(async () => {
  await h?.cleanup();
});

/** ffmpeg 6 ends the video one output frame (0.1 s) early, 9 does not: allow for that. */
const expectLength = (info: { duration: number; frames: number }, seconds: number): void => {
  expect(Math.abs(info.duration - seconds)).toBeLessThanOrEqual(0.15);
  expect(Math.abs(info.frames - Math.round(seconds * 10))).toBeLessThanOrEqual(1);
};

const probe = async (file: string): Promise<{ codec: string; pixFmt: string; width: number; height: number; frames: number; duration: number }> => {
  const out = await run(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height,nb_read_frames:format=duration', '-of', 'json', file],
    { timeoutMs: 30_000 },
  );
  const json = JSON.parse(out.stdout) as { streams: Array<Record<string, string>>; format: { duration: string } };
  const s = json.streams[0]!;
  return { codec: s.codec_name!, pixFmt: s.pix_fmt!, width: Number(s.width), height: Number(s.height), frames: Number(s.nb_read_frames), duration: Number(json.format.duration) };
};

describe('replay video', () => {
  it.runIf(canEncode)('finish builds replay-<shortTree>.mp4 of the session frames in order, linked from the proof block', async () => {
    const result = await h.finish();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    const short = tree.slice(0, 8);
    const mp4 = path.join(h.dirs.artifactDir, `replay-${short}.mp4`);
    expect(result.replay).toMatchObject({ path: mp4, frames: Math.min(60, sessionFrames), captions: ffmpeg.drawtext });
    expect(sessionFrames).toBeGreaterThanOrEqual(5);
    console.log(`replay: ${result.replay!.frames} frames, ${result.replay!.seconds} s of video built in ${result.replay!.ms} ms (ffmpeg ${ffmpeg.version}, captions ${ffmpeg.drawtext})`);

    const info = await probe(mp4);
    expect(info.codec).toBe('h264');
    expect(info.pixFmt).toBe('yuv420p');
    expect(info.width).toBe(h.config.viewport.width);
    expect(info.height % 2).toBe(0);
    expectLength(info, result.replay!.frames * 1.2);

    // faststart: the moov atom comes before the media data, so the file plays while it downloads.
    const bytes = fs.readFileSync(mp4);
    expect(bytes.indexOf('moov')).toBeGreaterThan(-1);
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'));

    const block = fs.readFileSync(result.proofBlockPath, 'utf8');
    expect(block).toContain(`[Replay](${mp4}) · ${result.replay!.frames} frame(s), ${result.replay!.seconds} s`);
    // Only the stills and the video are in the artifact dir.
    expect(fs.readdirSync(h.dirs.artifactDir).filter((f) => f.endsWith('.mp4'))).toEqual([`replay-${short}.mp4`]);
    expect(fs.readdirSync(h.dirs.scratchDir).filter((f) => f.startsWith('replay-'))).toEqual([]);
  });

  it.runIf(canEncode)('the real CLI builds it too', async () => {
    const cli = await h.cli('finish', '--json');
    expect(cli.code).toBe(0);
    const result = JSON.parse(cli.stdout) as FinishResult;
    expect(result.replay?.path).toBe(path.join(h.dirs.artifactDir, `replay-${tree.slice(0, 8)}.mp4`));
    expect(fs.existsSync(result.replay!.path)).toBe(true);
  });

  it.runIf(canEncode)('replay.maxFrames keeps the latest frames only', async () => {
    const result = await runFinish({ ...h.config, replay: { ...h.config.replay, maxFrames: 3 } }, { env: h.env });
    expect(result.replay).toMatchObject({ frames: 3, seconds: 3.6 });
    const info = await probe(result.replay!.path);
    expectLength(info, 3.6);
  });

  it.runIf(canEncode)('replay.secondsPerFrame sets how long each frame is shown', async () => {
    const result = await runFinish({ ...h.config, replay: { ...h.config.replay, maxFrames: 4, secondsPerFrame: 0.5 } }, { env: h.env });
    expect(result.replay).toMatchObject({ frames: 4, seconds: 2 });
    const info = await probe(result.replay!.path);
    expectLength(info, 2);
  });

  it.runIf(canEncode && ffmpeg.drawtext)('draws the caption bar when drawtext is available', async () => {
    const result = await h.finish();
    expect(result.replay!.captions).toBe(true);
    expect(result.notes.join('\n')).not.toContain('without captions');
    const info = await probe(result.replay!.path);
    expect(info.height).toBeGreaterThan(36); // picture area plus the caption bar
  });

  it.runIf(canEncode && !ffmpeg.drawtext)('without drawtext it builds without captions and says so', async () => {
    const result = await h.finish();
    expect(result.replay!.captions).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.notes.some((n) => n.startsWith('replay built without captions: '))).toBe(true);
  });

  it('with no ffmpeg on PATH it is skipped cleanly: a note, no video, no failure', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-nopath-'));
    try {
      const result = await h.finish({ env: { ...h.env, PATH: empty } });
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.replay).toBeUndefined();
      expect(result.notes).toContain('replay skipped: ffmpeg not found');
      const block = fs.readFileSync(result.proofBlockPath, 'utf8');
      expect(block).toContain('- replay skipped: ffmpeg not found');
      expect(block).not.toContain('[Replay]');
      expect(fs.readdirSync(h.dirs.artifactDir).filter((f) => f.endsWith('.mp4')).every((f) => f.startsWith('replay-'))).toBe(true);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('replay.enabled: false builds nothing and says nothing', async () => {
    const result = await runFinish({ ...h.config, replay: { ...h.config.replay, enabled: false } }, { env: h.env });
    expect(result.ok).toBe(true);
    expect(result.replay).toBeUndefined();
    expect(result.notes.some((n) => n.startsWith('replay'))).toBe(false);
  });
});

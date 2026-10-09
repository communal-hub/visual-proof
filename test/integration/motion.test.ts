import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFinish } from '../../src/finish.js';
import { Browser } from '../../src/browser.js';
import { CURSOR_ID, readClip } from '../../src/motion.js';
import { parseSidecar, sidecarRoute } from '../../src/sidecar.js';
import { decodePng } from './png.js';
import { probeFfmpeg, run } from '../../src/replay.js';
import type { FrameEvent } from '../../src/watch.js';
import { createHarness, type Harness } from './harness.js';

const ffmpeg = await probeFfmpeg();
const ffprobe = (await run('ffprobe', ['-version'], { timeoutMs: 10_000 })).code === 0;
const canEncode = ffmpeg.found && ffmpeg.x264 && ffprobe;
if (!canEncode) console.warn(`motion replay tests skipped: ffmpeg ${ffmpeg.found ? 'found' : 'not found'}, libx264 ${ffmpeg.x264}, ffprobe ${ffprobe}`);

const INTERACT = '/manage/interact';
let h: Harness;
let form: string;
let modal: string;
let formStill: FrameEvent;
let tree: string;

beforeAll(async () => {
  if (!canEncode) return;
  h = await createHarness();
  await h.start();
  await h.waitForFrame((e) => e.frame.route === '/', 30_000, { from: 0 }).catch(() => {});
  form = h.writeSidecar('form', `goto ${INTERACT}\nfill [data-test=name-input] "Ada Lovelace"\nclick [data-test=next]\nstill step-2\n`);
  formStill = await h.waitForFrame((e) => e.frame.route === sidecarRoute(form, 'step-2'), 30_000, { from: 0 });
  modal = h.writeSidecar('modal', `goto ${INTERACT}\nclick [data-test=open-modal]\nwait [data-test=confirm-modal]\nstill modal-open\n`);
  await h.waitForFrame((e) => e.frame.route === sidecarRoute(modal, 'modal-open'), 30_000, { from: 0 });
  tree = h.commitAll('motion');
}, 120_000);
afterAll(async () => {
  await h?.cleanup();
});

const probe = async (file: string): Promise<{ width: number; height: number; frames: number; duration: number; fps: string }> => {
  const out = await run(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate:format=duration', '-of', 'json', file],
    { timeoutMs: 30_000 },
  );
  const json = JSON.parse(out.stdout) as { streams: Array<Record<string, string>>; format: { duration: string } };
  const s = json.streams[0]!;
  return { width: Number(s.width), height: Number(s.height), frames: Number(s.nb_read_frames), duration: Number(json.format.duration), fps: s.r_frame_rate! };
};

describe.runIf(canEncode)('motion replay', () => {
  it('records a scenario run as a clip the stills point to: the flow, then a hold on each still', () => {
    const { frame, pngPath } = formStill;
    expect(frame.clip).toMatch(/^clips\/c-/);
    const dir = h.timeline().clipPath(frame)!;
    const manifest = readClip(dir)!;
    expect(manifest).not.toBeNull();
    expect(manifest.width).toBe(h.config.viewport.width);
    expect(manifest.frames.length).toBeGreaterThan(10); // the typing and the gliding cursor paint many frames
    for (const f of manifest.frames) expect(fs.existsSync(path.join(dir, f.file))).toBe(true);
    // Every JPEG on disk is in the manifest (the ones captured mid-still were removed).
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).length).toBe(manifest.frames.length);
    expect(manifest.captions.map((c) => c.text)).toEqual([
      'form / goto /manage/interact',
      'form / fill [data-test=name-input] "Ada Lovelace"',
      'form / click [data-test=next]',
      'form / still step-2',
    ]);
    // The still holds for secondsPerFrame and the clip ends on another hold of the last frame.
    const still = manifest.captions.at(-1)!.t;
    expect(manifest.duration - still).toBeGreaterThanOrEqual(2 * 1200 - 50);
    expect(fs.existsSync(pngPath)).toBe(true);
  });

  it('typing ends with the value a fill would leave', () => {
    // step 2 of the form greets the name typed in step 1
    expect(formStill.signals.text).toContain('Ada Lovelace');
  });

  it('finish builds a 25 fps replay with the clips in place of their stills', async () => {
    const result = await h.finish();
    expect(result.failures).toEqual([]);
    const mp4 = path.join(h.dirs.artifactDir, `replay-${tree.slice(0, 8)}.mp4`);
    expect(result.replay).toMatchObject({ path: mp4, clips: 2 });
    const info = await probe(mp4);
    expect(info.fps).toBe('25/1');
    expect(info.width).toBe(h.config.viewport.width);
    expect(info.height).toBe(h.config.viewport.height + (ffmpeg.drawtext ? 36 : 0));
    expect(Math.abs(info.duration - result.replay!.seconds)).toBeLessThanOrEqual(0.2);
    console.log(`motion replay: ${result.replay!.seconds} s, ${result.replay!.clips} clip(s), built in ${result.replay!.ms} ms`);
    const block = fs.readFileSync(result.proofBlockPath, 'utf8');
    expect(block).toContain(`, ${result.replay!.seconds} s, 2 motion clip(s)`);
    if (process.env.VP_KEEP_REPLAY) fs.copyFileSync(mp4, process.env.VP_KEEP_REPLAY);
  });

  it('replay.motion: false builds the stills-only replay from the same frames', async () => {
    const stills = await runFinish({ ...h.config, replay: { ...h.config.replay, motion: false } }, { env: h.env });
    expect(stills.replay).toMatchObject({ clips: 0 });
    expect((await probe(stills.replay!.path)).fps).toBe('10/1');
  });
});

describe.runIf(canEncode)('Browser.runScenario recording', () => {
  it('the drawn cursor is on the page while recording, and never in a still', async () => {
    const seen: Array<{ display: string; x: number; y: number } | null> = [];
    const browser = await Browser.launch(h.config, {
      beforeScreenshot: async (page) => {
        seen.push(
          await page.evaluate(`(() => {
            const el = document.getElementById(${JSON.stringify(CURSOR_ID)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { display: getComputedStyle(el).display, x: r.x, y: r.y };
          })()`),
        );
      },
    });
    const dir = path.join(h.dirs.scratchDir, 'clips', 'browser-test');
    try {
      const file = '.visual-proof/sidecars/cursor.vp';
      // The cursor ends over the Next button, which step 2 replaces with blank space.
      const sidecar = parseSidecar(`goto ${INTERACT}\nclick [data-test=next]\nstill after\n`, file);
      const result = await browser.runScenario({
        file,
        name: 'cursor',
        steps: sidecar.steps,
        gotos: new Map([[1, { url: `${h.appUrl}${INTERACT}`, path: INTERACT }]]),
        record: { dir, holdMs: 500 },
      });
      expect(result.failure).toBeUndefined();
      expect(result.clip).toMatchObject({ dir });
      expect(readClip(dir)!.duration).toBeGreaterThan(1000);

      const at = seen[0]!;
      expect(at.display).toBe('block'); // visible on the page right up to the screenshot
      const png = decodePng(result.stills[0]!.png);
      // The arrow's body is a dark outline around white, just right of and below its tip: none of it in the still.
      for (let dy = 4; dy <= 18; dy += 2) {
        for (let dx = 2; dx <= 8; dx += 2) {
          const [r, g, b] = png.pixel(Math.round(at.x) + dx, Math.round(at.y) + dy);
          expect(Math.min(r, g, b), `pixel at +${dx},+${dy}`).toBeGreaterThan(200);
        }
      }
    } finally {
      await browser.close();
    }
  });

  it('without a record request nothing is recorded and no cursor is drawn', async () => {
    const seen: unknown[] = [];
    const browser = await Browser.launch(h.config, {
      beforeScreenshot: async (page) => {
        seen.push(await page.evaluate(`document.getElementById(${JSON.stringify(CURSOR_ID)})`));
      },
    });
    try {
      const file = '.visual-proof/sidecars/plain.vp';
      const sidecar = parseSidecar(`goto ${INTERACT}\nclick [data-test=next]\nstill after\n`, file);
      const result = await browser.runScenario({ file, name: 'plain', steps: sidecar.steps, gotos: new Map([[1, { url: `${h.appUrl}${INTERACT}`, path: INTERACT }]]) });
      expect(result.clip).toBeUndefined();
      expect(seen).toEqual([null]);
    } finally {
      await browser.close();
    }
  });
});

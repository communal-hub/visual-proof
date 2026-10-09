import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIP_MANIFEST,
  clipTime,
  glideMs,
  glidePath,
  nonCssSelectors,
  readClip,
  recordingStyleScript,
  resampleClip,
  typingDelayMs,
  type ClipManifest,
} from '../../src/motion.js';
import { tmpDir } from './helpers.js';

describe('glidePath', () => {
  it('ends exactly on the target, eased: small steps at both ends, big ones in the middle', () => {
    const points = glidePath({ x: 0, y: 0 }, { x: 600, y: 0 });
    expect(points.at(-1)).toEqual({ x: 600, y: 0 });
    expect(points.length).toBe(Math.round(glideMs(600) / 16));
    const steps = points.map((p, i) => p.x - (i > 0 ? points[i - 1]!.x : 0));
    const mid = Math.floor(steps.length / 2);
    expect(steps[0]).toBeLessThan(steps[mid]!);
    expect(steps.at(-1)).toBeLessThan(steps[mid]!);
    for (const p of points) expect(p.y).toBe(0);
  });

  it('a target under the cursor is one move', () => {
    expect(glidePath({ x: 10, y: 10 }, { x: 10.4, y: 10 })).toEqual([{ x: 10.4, y: 10 }]);
  });

  it('glides take longer over longer distances, within bounds', () => {
    expect(glideMs(0)).toBe(280);
    expect(glideMs(400)).toBeGreaterThan(glideMs(100));
    expect(glideMs(10_000)).toBe(900);
  });
});

describe('typingDelayMs', () => {
  it('types any value in about a second, never slower than 70 ms or faster than 15 ms a key', () => {
    expect(typingDelayMs(1)).toBe(70);
    expect(typingDelayMs(22)).toBe(50);
    expect(typingDelayMs(500)).toBe(15);
    expect(typingDelayMs(0)).toBe(70);
  });
});

describe('clipTime', () => {
  const pauses = [
    { from: 2000, to: 2600, holdMs: 1200 }, // a still: 600 ms of preparing shown as a 1.2 s hold
    { from: 5000, to: 5100, holdMs: 0 },
  ];

  it('is wall time since the start until the first pause', () => {
    expect(clipTime(1500, 1000, pauses)).toBe(500);
  });

  it('drops what was captured during a pause, or with clamp puts it at the end of the hold', () => {
    expect(clipTime(2300, 1000, pauses)).toBeNull();
    expect(clipTime(2300, 1000, pauses, true)).toBe(1000 + 1200);
  });

  it('after a pause, clip time is shifted by the hold minus the paused stretch', () => {
    expect(clipTime(2600, 1000, pauses)).toBe(1600 + 600);
    expect(clipTime(3000, 1000, pauses)).toBe(2000 + 600);
    expect(clipTime(6000, 1000, pauses)).toBe(5000 + 600 - 100);
    expect(clipTime(5050, 1000, pauses, true)).toBe(4000 + 600);
  });
});

describe('resampleClip', () => {
  const manifest: Pick<ClipManifest, 'frames' | 'captions' | 'duration'> = {
    duration: 1000,
    frames: [
      { file: 'a.jpg', t: 0 },
      { file: 'b.jpg', t: 130 },
      { file: 'c.jpg', t: 150 },
      { file: 'd.jpg', t: 700 },
    ],
    captions: [
      { t: 100, text: 'click' },
      { t: 600, text: 'still' },
    ],
  };

  it('each tick shows the newest frame at or before it, with the caption in effect then', () => {
    const ticks = resampleClip(manifest, 10);
    expect(ticks.map((t) => t.file)).toEqual(['a.jpg', 'a.jpg', 'c.jpg', 'c.jpg', 'c.jpg', 'c.jpg', 'c.jpg', 'd.jpg', 'd.jpg', 'd.jpg']);
    expect(ticks.map((t) => t.caption)).toEqual([-1, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('always has at least one tick', () => {
    expect(resampleClip({ ...manifest, duration: 0 }, 25)).toHaveLength(1);
  });
});

describe('readClip', () => {
  it('reads a manifest with frames, and is null for a missing, broken or empty one', () => {
    const dir = tmpDir('vp-clip-');
    expect(readClip(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, CLIP_MANIFEST), '{not json');
    expect(readClip(dir)).toBeNull();
    const manifest: ClipManifest = { version: 1, name: 'x', width: 10, height: 10, duration: 100, frames: [], captions: [] };
    fs.writeFileSync(path.join(dir, CLIP_MANIFEST), JSON.stringify(manifest));
    expect(readClip(dir)).toBeNull();
    manifest.frames.push({ file: '000001.jpg', t: 0 });
    fs.writeFileSync(path.join(dir, CLIP_MANIFEST), JSON.stringify(manifest));
    expect(readClip(dir)).toEqual(manifest);
  });
});

describe('recording styles', () => {
  it('carries the hide and mask selectors into the page script', () => {
    const script = recordingStyleScript(['#__vue-devtools-container__'], ['[data-test=clock]']);
    expect(script).toContain('"#__vue-devtools-container__"');
    expect(script).toContain('"[data-test=clock]"');
    expect(script).toContain('rgb(255, 0, 255)');
  });

  it('names the mask selectors that are Playwright syntax, not CSS', () => {
    expect(nonCssSelectors(['.price', 'text=Total', 'li >> nth=1', 'button:has-text("Pay")', '[data-x]'])).toEqual([
      'text=Total',
      'li >> nth=1',
      'button:has-text("Pay")',
    ]);
  });
});

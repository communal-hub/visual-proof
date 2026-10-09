import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Timeline, type NewFrame } from '../../src/timeline.js';
import { tmpDir } from './helpers.js';

let scratch: string;

beforeEach(() => {
  scratch = path.join(tmpDir('vp-timeline-'), 'scratch');
});

function frame(overrides: Partial<NewFrame> = {}): NewFrame {
  return {
    sessionId: 's-1',
    route: '/invoices/1',
    routeKey: '/invoices/:id',
    at: '2026-10-08T12:00:00.000Z',
    treeHash: 'a'.repeat(40),
    trigger: 'screen',
    status: 'clean',
    reasons: [],
    ...overrides,
  };
}

const png = (n: number): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47, n]);

describe('Timeline.append / list', () => {
  it('writes the PNG and an index line, and returns the record', () => {
    const tl = new Timeline(scratch, 10);
    const rec = tl.append(frame({ sourceFile: 'src/pages/Invoice.vue' }), png(1));

    expect(rec).toMatchObject({ id: 'f-000001', png: 'frames/f-000001.png', sourceFile: 'src/pages/Invoice.vue' });
    expect(fs.readFileSync(path.join(scratch, 'frames', 'f-000001.png')).equals(png(1))).toBe(true);
    const lines = fs.readFileSync(path.join(scratch, 'index.jsonl'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(rec);
    expect(tl.pngPath(rec)).toBe(path.join(scratch, 'frames', 'f-000001.png'));
  });

  it('assigns monotonically increasing ids, oldest first', () => {
    const tl = new Timeline(scratch, 10);
    const ids = [1, 2, 3].map((n) => tl.append(frame(), png(n)).id);
    expect(ids).toEqual(['f-000001', 'f-000002', 'f-000003']);
    expect(tl.list().map((f) => f.id)).toEqual(ids);
  });

  it('leaves no temp files behind', () => {
    const tl = new Timeline(scratch, 10);
    tl.append(frame(), png(1));
    expect(fs.readdirSync(path.join(scratch, 'frames'))).toEqual(['f-000001.png']);
    expect(fs.readdirSync(scratch).sort()).toEqual(['frames', 'index.jsonl']);
  });

  it('lists nothing before the first append', () => {
    expect(new Timeline(scratch, 10).list()).toEqual([]);
  });

  it('filters by sessionId', () => {
    const tl = new Timeline(scratch, 10);
    tl.append(frame({ sessionId: 's-1' }), png(1));
    tl.append(frame({ sessionId: 's-2' }), png(2));
    tl.append(frame({ sessionId: 's-1' }), png(3));
    expect(tl.list({ sessionId: 's-1' }).map((f) => f.id)).toEqual(['f-000001', 'f-000003']);
    expect(tl.list({ sessionId: 'nope' })).toEqual([]);
  });

  it('skips a torn trailing index line', () => {
    const tl = new Timeline(scratch, 10);
    tl.append(frame(), png(1));
    fs.appendFileSync(path.join(scratch, 'index.jsonl'), '{"id":"f-0000');
    expect(tl.list().map((f) => f.id)).toEqual(['f-000001']);
  });

  it('rejects a non-positive maxFrames', () => {
    expect(() => new Timeline(scratch, 0)).toThrow(RangeError);
  });
});

describe('Timeline id continuity', () => {
  it('continues the sequence from a new instance over the same scratch dir', () => {
    new Timeline(scratch, 10).append(frame(), png(1));
    new Timeline(scratch, 10).append(frame(), png(2));
    const tl = new Timeline(scratch, 10);
    expect(tl.append(frame(), png(3)).id).toBe('f-000003');
    expect(tl.list().map((f) => f.id)).toEqual(['f-000001', 'f-000002', 'f-000003']);
  });

  it('keeps counting past evicted ids after a restart', () => {
    const first = new Timeline(scratch, 2);
    for (let n = 1; n <= 5; n++) first.append(frame(), png(n));
    const second = new Timeline(scratch, 2);
    expect(second.append(frame(), png(6)).id).toBe('f-000006');
  });
});

describe('Timeline eviction', () => {
  it('evicts the oldest records and PNGs beyond maxFrames', () => {
    const tl = new Timeline(scratch, 3);
    for (let n = 1; n <= 5; n++) tl.append(frame(), png(n));

    expect(tl.list().map((f) => f.id)).toEqual(['f-000003', 'f-000004', 'f-000005']);
    expect(fs.readdirSync(path.join(scratch, 'frames')).sort()).toEqual([
      'f-000003.png',
      'f-000004.png',
      'f-000005.png',
    ]);
    const lines = fs.readFileSync(path.join(scratch, 'index.jsonl'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('does not evict at exactly maxFrames', () => {
    const tl = new Timeline(scratch, 2);
    tl.append(frame(), png(1));
    tl.append(frame(), png(2));
    expect(tl.list()).toHaveLength(2);
    expect(fs.readdirSync(path.join(scratch, 'frames'))).toHaveLength(2);
  });

  it('evicts across all sessions, oldest first', () => {
    const tl = new Timeline(scratch, 2);
    tl.append(frame({ sessionId: 's-1' }), png(1));
    tl.append(frame({ sessionId: 's-2' }), png(2));
    tl.append(frame({ sessionId: 's-1' }), png(3));
    expect(tl.list().map((f) => [f.id, f.sessionId])).toEqual([
      ['f-000002', 's-2'],
      ['f-000003', 's-1'],
    ]);
  });

  it('tolerates a PNG that is already gone', () => {
    const tl = new Timeline(scratch, 1);
    const first = tl.append(frame(), png(1));
    fs.rmSync(tl.pngPath(first));
    expect(() => tl.append(frame(), png(2))).not.toThrow();
  });

  it('shrinks an oversized index when reopened with a lower cap on the next append', () => {
    const big = new Timeline(scratch, 10);
    for (let n = 1; n <= 5; n++) big.append(frame(), png(n));
    const small = new Timeline(scratch, 2);
    small.append(frame(), png(6));
    expect(small.list().map((f) => f.id)).toEqual(['f-000005', 'f-000006']);
    expect(fs.readdirSync(path.join(scratch, 'frames'))).toHaveLength(2);
  });
});

describe('Timeline.latestAtTree', () => {
  const tree1 = '1'.repeat(40);
  const tree2 = '2'.repeat(40);

  it('returns the most recent frame for the route at the tree hash', () => {
    const tl = new Timeline(scratch, 10);
    tl.append(frame({ treeHash: tree1, status: 'clean' }), png(1));
    tl.append(frame({ treeHash: tree1, status: 'error', reasons: ['x'] }), png(2));
    tl.append(frame({ treeHash: tree2 }), png(3));
    expect(tl.latestAtTree('/invoices/1', tree1)).toMatchObject({ id: 'f-000002', status: 'error' });
  });

  it('matches by concrete path or route pattern', () => {
    const tl = new Timeline(scratch, 10);
    tl.append(frame({ treeHash: tree1 }), png(1));
    expect(tl.latestAtTree('/invoices/:id', tree1)?.id).toBe('f-000001');
    expect(tl.latestAtTree('/invoices/1', tree1)?.id).toBe('f-000001');
  });

  it('does not fall back to another tree hash or another route', () => {
    const tl = new Timeline(scratch, 10);
    tl.append(frame({ treeHash: tree1 }), png(1));
    tl.append(frame({ treeHash: tree1, route: '/other', routeKey: '/other' }), png(2));
    expect(tl.latestAtTree('/invoices/1', tree2)).toBeUndefined();
    expect(tl.latestAtTree('/missing', tree1)).toBeUndefined();
  });

  it('sees frames written by another instance', () => {
    new Timeline(scratch, 10).append(frame({ treeHash: tree1 }), png(1));
    expect(new Timeline(scratch, 10).latestAtTree('/invoices/1', tree1)?.id).toBe('f-000001');
  });
});

describe('Timeline clips (v0.9)', () => {
  it('a clip dir is removed with the last frame that uses it', () => {
    const tl = new Timeline(scratch, 2);
    const a = tl.newClip();
    const b = tl.newClip();
    expect(a.clip).not.toBe(b.clip);
    expect(a.dir).toBe(path.join(scratch, a.clip));
    for (const c of [a, b]) {
      fs.mkdirSync(c.dir, { recursive: true });
      fs.writeFileSync(path.join(c.dir, 'manifest.json'), '{}');
    }
    tl.append(frame({ clip: a.clip }), png(1));
    tl.append(frame({ clip: a.clip }), png(2));
    const third = tl.append(frame({ clip: b.clip }), png(3)); // evicts frame 1; frame 2 still uses a
    expect(fs.existsSync(a.dir)).toBe(true);
    expect(tl.clipPath(third)).toBe(b.dir);
    tl.append(frame(), png(4)); // evicts frame 2: a goes
    expect(fs.existsSync(a.dir)).toBe(false);
    expect(fs.existsSync(b.dir)).toBe(true);
    expect(tl.clipPath(tl.list().at(-1)!)).toBeUndefined();
  });

  it('dropClip removes a clip no frame was written for', () => {
    const tl = new Timeline(scratch, 5);
    const c = tl.newClip();
    fs.mkdirSync(c.dir, { recursive: true });
    tl.dropClip(c.clip);
    expect(fs.existsSync(c.dir)).toBe(false);
  });
});

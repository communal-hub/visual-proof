import fs from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DecisionBudget } from '../../src/decisions/budget.js';
import {
  IMAGE_CONCURRENCY,
  IMAGE_CONFIDENCE_THRESHOLD,
  IMAGE_CRITERIA,
  IMAGE_TOKEN_GUARD,
  checkImages,
  describeImageCheck,
  imageCheckMessage,
} from '../../src/decisions/image-check.js';
import { CLEAN_PNG, FakeClient, choice, hang, okResult } from './decisions-helpers.js';
import { tmpDir } from './helpers.js';

const dir = tmpDir('vp-img-');
const png = (name: string): string => {
  const file = path.join(dir, `${name}.png`);
  fs.copyFileSync(CLEAN_PNG, file);
  return file;
};
const opts = (client: FakeClient, mode: 'fail' | 'warn' = 'warn', budgetMs = 5000) => ({
  client,
  model: 'luna',
  mode,
  budget: new DecisionBudget(budgetMs),
});

describe('image check', () => {
  it('sends the PNG as an image_url part with the four-way choice, and names the model asked', async () => {
    const client = new FakeClient(() => okResult({ frame: choice('clean') }));
    await checkImages([{ png: png('a'), name: '/a' }], opts(client));
    const call = client.calls[0]!;
    expect(call.model).toBe('luna');
    expect(call.state).toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${fs.readFileSync(CLEAN_PNG).toString('base64')}` } }]);
    expect(Object.keys(call.questions)).toEqual(['frame']);
    expect(call.questions.frame!.type).toBe('choice');
    expect(Object.keys(call.questions.frame!.criteria as object)).toEqual(['clean', 'loading', 'error', 'blank']);
    expect(IMAGE_CRITERIA.error).toContain('error');
  });

  it.each([
    ['error', 0.7, 'fail'],
    ['error', 0.69, 'none'],
    ['blank', 1, 'fail'],
    ['loading', 0.95, 'fail'],
    ['clean', 1, 'none'],
    ['clean', 0.2, 'none'],
  ] as const)('%s at %s acts as %s (fail mode)', async (label, confidence, action) => {
    const client = new FakeClient(() => okResult({ frame: choice(label, confidence) }));
    const [check] = await checkImages([{ png: png('t'), name: '/t' }], opts(client, 'fail'));
    expect(check).toMatchObject({ label, confidence, action });
  });

  it('warn mode flags the same frames as a warning, not a failure', async () => {
    const client = new FakeClient(() => okResult({ frame: choice('error', 0.9) }));
    const [check] = await checkImages([{ png: png('w'), name: '/w' }], opts(client, 'warn'));
    expect(check!.action).toBe('warn');
    expect(IMAGE_CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  it('falls back to the probability of the chosen label when no confidence is reported', async () => {
    const client = new FakeClient(() => okResult({ frame: { type: 'choice', choice: 'error', probabilities: { error: 0.8, clean: 0.2 } } }));
    const [check] = await checkImages([{ png: png('p'), name: '/p' }], opts(client, 'fail'));
    expect(check).toMatchObject({ label: 'error', confidence: 0.8, action: 'fail' });
  });

  it('checks a 1280x2420 full-page still using readable top detail and resized page context, even at 3.2k tokens', async () => {
    const tall = path.join(dir, 'tall.png');
    await sharp({ create: { width: 1280, height: 2420, channels: 3, background: '#ffffff' } }).png().toFile(tall);
    const client = new FakeClient(() => okResult({ frame: choice('clean', 1) }, { inputTokens: 3200 }));
    const [check] = await checkImages([{ png: tall, name: '/tall' }], opts(client));
    expect(check).toMatchObject({ label: 'clean', action: 'none' });
    const parts = (client.calls[0]!.state as Array<{ type?: string; image_url?: { url: string } }>).filter((p) => p.type === 'image_url');
    expect(parts).toHaveLength(2);
    const dimensions = await Promise.all(parts.map((p) => sharp(Buffer.from(p.image_url!.url.split(',')[1]!, 'base64')).metadata()));
    expect(dimensions[0]).toMatchObject({ width: 1280, height: 800 });
    expect(dimensions[1]).toMatchObject({ height: 1600 });
    expect(dimensions[1]!.width).toBeLessThan(1280);
  });

  it('rejects a corrupt screenshot before a model call', async () => {
    const broken = path.join(dir, 'broken.png');
    fs.writeFileSync(broken, 'not a PNG');
    const client = new FakeClient(() => okResult({ frame: choice('clean') }));
    expect((await checkImages([{ png: broken, name: '/broken' }], opts(client)))[0]!.label).toBe('unknown');
    expect(client.calls).toHaveLength(0);
  });

  it('treats an answer from a request that read the image as text (wildly inflated input tokens) as unknown, and logs loudly', async () => {
    const client = new FakeClient(() => okResult({ frame: choice('error', 0.95) }, { inputTokens: 17_233 }));
    const logs: string[] = [];
    const [check] = await checkImages([{ png: png('g'), name: '/g' }], { ...opts(client, 'fail'), log: (m) => logs.push(m) });
    expect(check).toMatchObject({ label: 'unknown', action: 'none', confidence: null });
    expect(check!.note).toContain('17233 input tokens');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('ERROR');
    // The boundary: exactly the guard is fine.
    const edge = new FakeClient(() => okResult({ frame: choice('error', 0.95) }, { inputTokens: IMAGE_TOKEN_GUARD }));
    expect((await checkImages([{ png: png('e'), name: '/e' }], opts(edge, 'fail')))[0]!.action).toBe('fail');
  });

  it('is unknown (never a failure) when the request fails, the answer is missing or the label is not one of the four', async () => {
    const down = new FakeClient(() => ({ ok: false, kind: 'http', status: 503, error: 'HTTP 503: down', ms: 3 }));
    expect((await checkImages([{ png: png('d'), name: '/d' }], opts(down, 'fail')))[0]).toMatchObject({ label: 'unknown', action: 'none', note: 'HTTP 503: down' });
    const odd = new FakeClient(() => okResult({ frame: choice('maybe', 1) }));
    expect((await checkImages([{ png: png('o'), name: '/o' }], opts(odd, 'fail')))[0]).toMatchObject({ label: 'unknown', action: 'none' });
    const none = new FakeClient(() => okResult({}));
    expect((await checkImages([{ png: png('n'), name: '/n' }], opts(none, 'fail')))[0]!.label).toBe('unknown');
    const missing = new FakeClient(() => okResult({ frame: choice('error') }));
    expect((await checkImages([{ png: path.join(dir, 'gone.png'), name: '/gone' }], opts(missing, 'fail')))[0]!.note).toContain('cannot read');
    expect(missing.calls).toHaveLength(0);
  });

  it('runs requests concurrently, at most 6 at once, keeping results in input order', async () => {
    const client = new FakeClient(async (_req, n) => {
      await new Promise((r) => setTimeout(r, 20));
      return okResult({ frame: choice(n % 2 === 0 ? 'error' : 'clean', 1) });
    });
    const inputs = Array.from({ length: 14 }, (_, i) => ({ png: png(`c${i}`), name: `/c${i}` }));
    const checks = await checkImages(inputs, opts(client, 'fail'));
    expect(checks).toHaveLength(14);
    expect(client.calls).toHaveLength(14);
    expect(client.maxInFlight).toBeLessThanOrEqual(IMAGE_CONCURRENCY);
    expect(client.maxInFlight).toBeGreaterThan(1);
    expect(checks.every((c) => c.label !== 'unknown')).toBe(true);
  });

  it('skips with a note when the budget is already spent, and cuts off a request that outlives it', async () => {
    const spent = new DecisionBudget(1);
    spent.start();
    await new Promise((r) => setTimeout(r, 10));
    const never = new FakeClient(() => okResult({ frame: choice('clean') }));
    const [skipped] = await checkImages([{ png: png('s'), name: '/s' }], { ...opts(never), budget: spent });
    expect(skipped).toMatchObject({ label: 'unknown', note: 'skipped: decision budget exhausted' });
    expect(never.calls).toHaveLength(0);

    const stuck = new FakeClient(hang);
    const t0 = Date.now();
    const [cut] = await checkImages([{ png: png('h'), name: '/h' }], opts(stuck, 'fail', 60));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(cut).toMatchObject({ label: 'unknown', action: 'none', note: 'skipped: decision budget exhausted' });
  });

  it('formats the failure message and the status-line fragment', () => {
    const check = { label: 'error' as const, confidence: 0.923, action: 'fail' as const, ms: 1 };
    expect(imageCheckMessage('/reports', check)).toBe('/reports looks error to the image check (0.92)');
    expect(describeImageCheck(check)).toBe('image check: error (0.92)');
    expect(describeImageCheck({ label: 'unknown', confidence: null, action: 'none', ms: 1 })).toBe('image check: unknown');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DecisionsClient,
  UnavailableClient,
  choiceAnswer,
  choiceConfidence,
  imageState,
  loadApiKey,
  noulAnswer,
} from '../../src/decisions/client.js';
import { fixture } from './decisions-helpers.js';
import { tmpDir } from './helpers.js';

type FetchCall = { url: string; init: RequestInit };

/** A fetch that answers from a script and records what it was asked. */
function scripted(responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>) {
  const calls: FetchCall[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(init) : next.clone();
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });

const QUESTIONS = { frame: { type: 'choice' as const, instructions: 'x', criteria: { clean: 'a', error: 'b' } } };
const noSleep = async () => {};

describe('DecisionsClient', () => {
  it('posts { model, state, questions } with a bearer key and parses the typed answers and usage', async () => {
    const { fn, calls } = scripted([json(fixture('luna-choice-error.json'))]);
    const client = new DecisionsClient({ apiKey: 'sk-test-123', fetch: fn });
    const result = await client.decide({ model: 'openai/gpt-6-luna-decisions-20261006', state: imageState(Buffer.from('png')), questions: QUESTIONS });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test-123');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body.state).toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png').toString('base64')}` } }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe('openai/gpt-6-luna-decisions-20261006');
    expect(result.usage).toEqual({ inputTokens: 1188, outputTokens: 0, cost: 0.0001188 });
    const answer = choiceAnswer(result, 'frame')!;
    expect(answer.choice).toBe('error');
    expect(choiceConfidence(answer)).toBe(1);
    expect(noulAnswer(result, 'frame')).toBeUndefined();
  });

  it('reports the resolved model id and noul probabilities from a Jev answer', async () => {
    const { fn } = scripted([json(fixture('jev-noul-prune.json'))]);
    const client = new DecisionsClient({ apiKey: 'k', fetch: fn });
    const result = await client.decide({ model: 'typesafe/jev-1.13', state: { a: 1 }, questions: { r0: { type: 'noul', instructions: 'x' } } });
    expect(result.ok && result.model).toBe('typesafe/jev-1.13-20260917');
    expect(result.ok && result.requestedModel).toBe('typesafe/jev-1.13');
    expect(noulAnswer(result, 'r2')?.noul).toBe(0.07);
  });

  it('accumulates requests, cost, tokens and time across calls', async () => {
    const { fn } = scripted([json(fixture('luna-choice-clean.json')), json(fixture('jev-choice-caption.json'))]);
    const client = new DecisionsClient({ apiKey: 'k', fetch: fn });
    await client.decide({ model: 'm', state: [], questions: QUESTIONS });
    await client.decide({ model: 'm', state: {}, questions: QUESTIONS });
    expect(client.stats.requests).toBe(2);
    expect(client.stats.failed).toBe(0);
    expect(client.stats.inputTokens).toBe(1188 + 494);
    expect(client.stats.cost).toBeCloseTo(0.0001188 + 0.000020748, 9);
  });

  it('retries once on 429 and honors retry-after (seconds), capped', async () => {
    const waits: number[] = [];
    const { fn, calls } = scripted([json('{"error":{"message":"slow down"}}', 429, { 'retry-after': '2' }), json(fixture('luna-choice-clean.json'))]);
    const client = new DecisionsClient({ apiKey: 'k', fetch: fn, sleep: async (ms) => void waits.push(ms) });
    const result = await client.decide({ model: 'm', state: [], questions: QUESTIONS });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
    expect(client.stats).toMatchObject({ requests: 1, retries: 1, failed: 0 });

    const capped = scripted([json('{}', 429, { 'retry-after': '120' }), json(fixture('luna-choice-clean.json'))]);
    const waits2: number[] = [];
    await new DecisionsClient({ apiKey: 'k', fetch: capped.fn, sleep: async (ms) => void waits2.push(ms), maxBackoffMs: 3000 }).decide({ model: 'm', state: [], questions: QUESTIONS });
    expect(waits2).toEqual([3000]);
  });

  it('retries once on a 5xx, then gives up with the status; it never retries a second time', async () => {
    const { fn, calls } = scripted([json('{"error":{"message":"upstream down"}}', 503)]);
    const client = new DecisionsClient({ apiKey: 'k', fetch: fn, sleep: noSleep });
    const result = await client.decide({ model: 'm', state: [], questions: QUESTIONS });
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ ok: false, kind: 'http', status: 503 });
    expect(!result.ok && result.error).toContain('upstream down');
    expect(client.stats).toMatchObject({ requests: 1, retries: 1, failed: 1 });
  });

  it('does not retry a 400 (a bad question or model)', async () => {
    const { fn, calls } = scripted([json(fixture('error-400-model.json'), 400)]);
    const client = new DecisionsClient({ apiKey: 'k', fetch: fn, sleep: noSleep });
    const result = await client.decide({ model: 'nope/does-not-exist', state: 'x', questions: QUESTIONS });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, kind: 'http', status: 400 });
    expect(!result.ok && result.error).toBe('HTTP 400: Model nope/does-not-exist does not exist');
  });

  it('times out each request and reports it', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    const { fn } = scripted([hang]);
    const client = new DecisionsClient({ apiKey: 'k', fetch: fn, timeoutMs: 30 });
    const result = await client.decide({ model: 'm', state: [], questions: QUESTIONS });
    expect(result).toMatchObject({ ok: false, kind: 'timeout' });
    expect(client.stats.failed).toBe(1);
  });

  it('aborts when the budget signal fires, also during the retry back-off, and not at all when already aborted', async () => {
    const controller = new AbortController();
    const { fn, calls } = scripted([json('{}', 429, { 'retry-after': '1' }), json(fixture('luna-choice-clean.json'))]);
    const client = new DecisionsClient({
      apiKey: 'k',
      fetch: fn,
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          controller.abort(); // the budget runs out while backing off
          signal?.aborted ? reject(new Error('aborted')) : reject(new Error('not signalled'));
        }),
    });
    const result = await client.decide({ model: 'm', state: [], questions: QUESTIONS, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, kind: 'aborted' });
    expect(calls).toHaveLength(1);

    const before = scripted([json(fixture('luna-choice-clean.json'))]);
    const pre = new AbortController();
    pre.abort();
    const skipped = await new DecisionsClient({ apiKey: 'k', fetch: before.fn }).decide({ model: 'm', state: [], questions: QUESTIONS, signal: pre.signal });
    expect(skipped).toMatchObject({ ok: false, kind: 'aborted' });
    expect(before.calls).toHaveLength(0);
  });

  it('reports a network failure and a non-JSON body without throwing', async () => {
    const down = new DecisionsClient({ apiKey: 'k', fetch: scripted([new Error('connect ECONNREFUSED')]).fn });
    expect(await down.decide({ model: 'm', state: [], questions: QUESTIONS })).toMatchObject({ ok: false, kind: 'network' });
    const html = new DecisionsClient({ apiKey: 'k', fetch: scripted([new Response('<html>', { status: 200 })]).fn });
    expect(await html.decide({ model: 'm', state: [], questions: QUESTIONS })).toMatchObject({ ok: false, kind: 'invalid', error: 'response is not JSON' });
    const empty = new DecisionsClient({ apiKey: 'k', fetch: scripted([json('{"ok":true}')]).fn });
    expect(await empty.decide({ model: 'm', state: [], questions: QUESTIONS })).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('never lets the key into an error message', async () => {
    const { fn } = scripted([json('{"error":{"message":"bad key sk-secret-key rejected"}}', 401)]);
    const result = await new DecisionsClient({ apiKey: 'sk-secret-key', fetch: fn }).decide({ model: 'm', state: [], questions: QUESTIONS });
    expect(!result.ok && result.error).toContain('<key>');
    expect(JSON.stringify(result)).not.toContain('sk-secret-key');
  });

  it('UnavailableClient answers every request with no-key and counts nothing', async () => {
    const client = new UnavailableClient();
    expect(await client.decide()).toMatchObject({ ok: false, kind: 'no-key' });
    expect(client.stats.requests).toBe(0);
  });
});

describe('loadApiKey', () => {
  it('prefers the environment, then a .env next to the config; null otherwise', () => {
    const dir = tmpDir('vp-key-');
    expect(loadApiKey({}, dir)).toBeNull();
    expect(loadApiKey({ OPENROUTER_API_KEY: '  sk-env  ' }, dir)).toEqual({ key: 'sk-env', source: 'env' });

    fs.writeFileSync(path.join(dir, '.env'), '# comment\nOTHER=1\nexport OPENROUTER_API_KEY="sk-file" # trailing\n');
    expect(loadApiKey({}, dir)).toEqual({ key: 'sk-file', source: '.env' });
    expect(loadApiKey({ OPENROUTER_API_KEY: 'sk-env' }, dir)?.source).toBe('env');

    fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=sk-bare # note\n');
    expect(loadApiKey({}, dir)?.key).toBe('sk-bare');
    fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=\n');
    expect(loadApiKey({}, dir)).toBeNull();
    expect(loadApiKey({ OPENROUTER_API_KEY: '   ' }, undefined)).toBeNull();
  });
});

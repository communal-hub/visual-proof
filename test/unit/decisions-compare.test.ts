import { describe, expect, it } from 'vitest';
import { DecisionBudget } from '../../src/decisions/budget.js';
import { comparePairs, describeCompare } from '../../src/decisions/compare.js';
import { CLEAN_PNG, FakeClient, hang, noul, okResult } from './decisions-helpers.js';

const pair = { name: '/facilities/3', before: CLEAN_PNG, after: CLEAN_PNG, expected: 'the booking spans the full column' };
const run = async (client: FakeClient, budgetMs = 5000) => {
  const budget = new DecisionBudget(budgetMs);
  try {
    return await comparePairs([pair], { client, model: 'typesafe/jev-1.13', budget });
  } finally {
    budget.dispose();
  }
};

describe('before/after comparison', () => {
  it.each([
    [0.93, 'changed', 'before → after: changed as claimed (0.93)'],
    [0.5, 'unclear', 'before → after: unclear (0.50)'],
    [0.1, 'unchanged', 'before → after: no change matching the claim (0.10)'],
  ])('a probability of %s is %s', async (p, result, line) => {
    const [check] = await run(new FakeClient(() => okResult({ change: noul(p) })));
    expect(check).toMatchObject({ result, probability: p });
    expect(describeCompare(check!)).toBe(line);
  });

  it('sends one request per pair: the before, then the after, and the claim line in the question', async () => {
    const client = new FakeClient(() => okResult({ change: noul(0.9) }));
    await run(client);
    expect(client.calls).toHaveLength(1);
    const state = client.calls[0]!.state as Array<string | { type?: string }>;
    expect(state[0]).toBe('Before (without the change):');
    expect(state.filter((p) => typeof p === 'object' && p.type === 'image_url')).toHaveLength(2);
    expect(state.indexOf('After (with the change):')).toBeGreaterThan(0);
    expect(JSON.stringify(client.calls[0]!.questions)).toContain('the booking spans the full column');
  });

  it('is unknown, with a note, when the budget runs out', async () => {
    const [check] = await run(new FakeClient(hang), 50);
    expect(check).toMatchObject({ result: 'unknown', probability: null, note: 'skipped: decision budget exhausted' });
  });
});

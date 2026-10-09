import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/config.js';
import { DEFAULT_TEXT_MODEL, DEFAULT_TRIAGE_MODEL, decisionsActive, describeMode, parseDecisions } from '../../src/decisions/config.js';

const parse = (decisions?: unknown, extra: Record<string, unknown> = {}) =>
  parseConfig({ appUrl: 'http://localhost:1', ...(decisions === undefined ? {} : { decisions }), ...extra }, '/repo', {});

describe('decisions config', () => {
  it('defaults: on when a key exists, warn, prune above 6 keep 4, verdict and captions on, 20 s, pinned models', () => {
    const { decisions, claimFile } = parse();
    expect(decisions).toEqual({
      models: { triage: DEFAULT_TRIAGE_MODEL, text: DEFAULT_TEXT_MODEL },
      triage: 'warn',
      prune: { above: 6, keep: 4 },
      verdict: true,
      captions: true,
      budgetMs: 20_000,
    });
    expect(decisions.enabled).toBeUndefined();
    expect(claimFile).toBeUndefined();
    expect(DEFAULT_TRIAGE_MODEL).toBe('openai/gpt-6-luna-decisions-20261006');
    expect(DEFAULT_TEXT_MODEL).toBe('typesafe/jev-1.13');
  });

  it('reads every setting', () => {
    const { decisions, claimFile } = parse(
      {
        enabled: true,
        models: { triage: 'a/b', text: 'c/d' },
        triage: 'fail',
        prune: { above: 3 },
        verdict: false,
        captions: false,
        budgetMs: 4000,
      },
      { claimFile: 'docs/claim.md' },
    );
    expect(decisions).toEqual({
      enabled: true,
      models: { triage: 'a/b', text: 'c/d' },
      triage: 'fail',
      prune: { above: 3, keep: 4 },
      verdict: false,
      captions: false,
      budgetMs: 4000,
    });
    expect(claimFile).toBe('docs/claim.md');
    expect(parse({ prune: false }).decisions.prune).toBe(false);
    expect(parse({ models: { text: 'typesafe/jev-1.13-20260917' } }).decisions.models).toEqual({ triage: DEFAULT_TRIAGE_MODEL, text: 'typesafe/jev-1.13-20260917' });
  });

  it('names every invalid field', () => {
    const errors: string[] = [];
    parseDecisions(
      { enabled: 'yes', models: { triage: '', vision: 'x' }, triage: 'loud', prune: { above: 0, keep: 1.5, extra: 1 }, verdict: 1, budgetMs: -5, nonsense: true },
      errors,
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        '"decisions.nonsense" is not a known setting (enabled, models, triage, prune, verdict, captions, budgetMs)',
        '"decisions.enabled" must be a boolean, got "yes"',
        '"decisions.models.triage" must be a non-empty model id, got ""',
        '"decisions.models.vision" is not a known model slot (triage, text)',
        '"decisions.triage" must be "fail", "warn" or "off", got "loud"',
        '"decisions.prune.above" must be a positive integer, got 0',
        '"decisions.prune.keep" must be a positive integer, got 1.5',
        '"decisions.prune.extra" is not a known setting (above, keep)',
        '"decisions.verdict" must be a boolean, got 1',
        '"decisions.budgetMs" must be a positive integer, got -5',
      ]),
    );
    expect(() => parse('on')).toThrow(ConfigError);
    expect(() => parse(['x'])).toThrow(/"decisions" must be an object/);
  });

  it('is active only with a key and without enabled:false', () => {
    const base = parse().decisions;
    expect(decisionsActive(base, true)).toBe(true);
    expect(decisionsActive(base, false)).toBe(false);
    expect(decisionsActive({ ...base, enabled: true }, false)).toBe(false);
    expect(decisionsActive({ ...base, enabled: false }, true)).toBe(false);
  });

  it('summarizes the mode for doctor', () => {
    const base = parse().decisions;
    expect(describeMode(base, false)).toBe('heuristics only (no OPENROUTER_API_KEY)');
    expect(describeMode({ ...base, enabled: false }, true)).toBe('off (decisions.enabled is false)');
    expect(describeMode(base, true)).toBe('triage warn, prune above 6 keep 4, verdict on, captions on, budget 20000 ms');
    expect(describeMode({ ...base, prune: false, verdict: false }, true)).toContain('prune off, verdict off');
  });
});

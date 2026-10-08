import { describe, expect, it } from 'vitest';
import { triage, type TriageSignals } from '../../src/triage.js';

const healthy: TriageSignals = {
  navOk: true,
  httpStatus: 200,
  consoleErrors: [],
  pageErrors: [],
  appRootPresent: true,
  appRootChildCount: 3,
  visibleSpinnerCount: 0,
};

describe('triage', () => {
  it('is clean for a healthy page', () => {
    expect(triage(healthy)).toEqual({ status: 'clean', reasons: [] });
  });

  it('rule 1: failed navigation is an error', () => {
    const result = triage({ ...healthy, navOk: false, httpStatus: null });
    expect(result.status).toBe('error');
    expect(result.reasons).toEqual(['navigation failed']);
  });

  it.each([500, 502, 503])('rule 1: HTTP %i is an error', (httpStatus) => {
    expect(triage({ ...healthy, httpStatus })).toEqual({ status: 'error', reasons: [`HTTP ${httpStatus}`] });
  });

  it('an auth failure (login failed or redirected to login) is an error', () => {
    const result = triage({ ...healthy, authFailure: 'redirected to /login' });
    expect(result).toEqual({ status: 'error', reasons: ['redirected to /login'] });
  });

  it('does not treat 4xx as an error by itself', () => {
    expect(triage({ ...healthy, httpStatus: 404 }).status).toBe('clean');
  });

  it('treats an unknown status (null) with a successful navigation as fine', () => {
    expect(triage({ ...healthy, httpStatus: null }).status).toBe('clean');
  });

  it('rule 2: console errors are an error, quoted in reasons', () => {
    expect(triage({ ...healthy, consoleErrors: ['boom'] })).toEqual({
      status: 'error',
      reasons: ['console error: boom'],
    });
  });

  it('rule 2: page errors are an error', () => {
    expect(triage({ ...healthy, pageErrors: ['TypeError: x'] })).toEqual({
      status: 'error',
      reasons: ['page error: TypeError: x'],
    });
  });

  it('lists every error source together', () => {
    const result = triage({ ...healthy, httpStatus: 500, consoleErrors: ['a'], pageErrors: ['b'] });
    expect(result.reasons).toEqual(['HTTP 500', 'console error: a', 'page error: b']);
  });

  it('clips very long messages', () => {
    const result = triage({ ...healthy, consoleErrors: ['x'.repeat(1000)] });
    expect(result.reasons[0]!.length).toBeLessThan(260);
    expect(result.reasons[0]).toMatch(/\.\.\.$/);
  });

  it('a failed screenshot is an error even when the DOM looks clean', () => {
    expect(triage({ ...healthy, screenshotError: 'Target closed' })).toEqual({
      status: 'error',
      reasons: ['screenshot failed: Target closed'],
    });
  });

  it('rule 3: missing app root is blank', () => {
    const result = triage({ ...healthy, appRootPresent: false, appRootChildCount: 0 });
    expect(result).toEqual({ status: 'blank', reasons: ['app root not found'] });
  });

  it('rule 3: app root without element children is blank', () => {
    const result = triage({ ...healthy, appRootChildCount: 0 });
    expect(result).toEqual({ status: 'blank', reasons: ['app root has no element children'] });
  });

  it('rule 4: a visible spinner is loading', () => {
    expect(triage({ ...healthy, visibleSpinnerCount: 2 })).toEqual({
      status: 'loading',
      reasons: ['2 visible spinner(s)'],
    });
  });

  describe('precedence', () => {
    it('error beats blank', () => {
      expect(triage({ ...healthy, consoleErrors: ['x'], appRootChildCount: 0 }).status).toBe('error');
    });

    it('error beats loading', () => {
      expect(triage({ ...healthy, pageErrors: ['x'], visibleSpinnerCount: 1 }).status).toBe('error');
    });

    it('navigation failure beats everything', () => {
      const result = triage({
        ...healthy,
        navOk: false,
        appRootPresent: false,
        appRootChildCount: 0,
        visibleSpinnerCount: 1,
      });
      expect(result.status).toBe('error');
    });

    it('blank beats loading', () => {
      expect(triage({ ...healthy, appRootChildCount: 0, visibleSpinnerCount: 1 }).status).toBe('blank');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { compileHostGlob, hostBlocker } from '../../src/hosts.js';
import { DEFAULT_BLOCK_HOSTS } from '../../src/config.js';

describe('compileHostGlob', () => {
  it('matches a leading *. against the bare domain and any depth of subdomain', () => {
    const re = compileHostGlob('*.sentry.io');
    for (const host of ['sentry.io', 'browser.sentry.io', 'o123.ingest.sentry.io']) expect(re.test(host)).toBe(true);
    for (const host of ['notsentry.io', 'sentry.io.evil.test', 'sentry.com']) expect(re.test(host)).toBe(false);
  });

  it('matches exact hosts, case-insensitively, and treats dots literally', () => {
    const re = compileHostGlob('CDN.Example.com');
    expect(re.test('cdn.example.com')).toBe(true);
    expect(re.test('cdnXexample.com')).toBe(false);
  });

  it('supports * inside a name and on its own', () => {
    expect(compileHostGlob('cdn*.example.com').test('cdn3.example.com')).toBe(true);
    expect(compileHostGlob('*').test('anything.test')).toBe(true);
  });
});

describe('hostBlocker', () => {
  const blocker = (extra: Partial<Parameters<typeof hostBlocker>[0]> = {}) =>
    hostBlocker({ blockHosts: DEFAULT_BLOCK_HOSTS, allowHosts: [], ownUrls: ['http://localhost:5173'], ...extra });

  it('blocks the default analytics hosts and nothing else', () => {
    const block = blocker();
    expect(block('https://www.google-analytics.com/g/collect?v=2')).toBe(true);
    expect(block('https://www.googletagmanager.com/gtm.js?id=GTM-1')).toBe(true);
    expect(block('https://eu.posthog.com/e/')).toBe(true);
    expect(block('https://api.segment.io/v1/t')).toBe(true);
    expect(block('https://static.hotjar.com/c/hotjar.js')).toBe(true);
    expect(block('https://widget.intercom.io/widget/abc')).toBe(true);
    expect(block('https://o1.ingest.sentry.io/api/1/envelope/')).toBe(true);
    expect(block('https://js.stripe.com/v3/')).toBe(false);
    expect(block('https://maps.googleapis.com/maps/api/js')).toBe(false);
    expect(block('https://fonts.gstatic.com/s/inter.woff2')).toBe(false);
    expect(block('http://localhost:5173/src/main.js')).toBe(false);
  });

  it('lets allowHosts carve exceptions out of the block list', () => {
    const block = blocker({ allowHosts: ['js.intercom.io'] });
    expect(block('https://js.intercom.io/x.js')).toBe(false);
    expect(block('https://widget.intercom.io/x.js')).toBe(true);
  });

  it('never blocks the app or dev server hosts, even with a catch-all', () => {
    const block = blocker({ blockHosts: ['*'], ownUrls: ['http://app.test:3000', 'http://localhost:5173'] });
    expect(block('http://app.test:3000/api/me')).toBe(false);
    expect(block('ws://localhost:5173/?token=x')).toBe(false);
    expect(block('https://cdn.other.test/lib.js')).toBe(true);
    expect(blocker({ blockHosts: ['*'], allowHosts: ['cdn.other.test'] })('https://cdn.other.test/lib.js')).toBe(false);
  });

  it('only considers http(s) and ws(s) URLs', () => {
    const block = blocker({ blockHosts: ['*'] });
    expect(block('data:image/png;base64,AAAA')).toBe(false);
    expect(block('blob:http://localhost:5173/abc')).toBe(false);
    expect(block('not a url')).toBe(false);
  });

  it('blocks nothing with an empty list', () => {
    expect(blocker({ blockHosts: [] })('https://www.google-analytics.com/')).toBe(false);
  });
});

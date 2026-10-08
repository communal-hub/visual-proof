/**
 * Hostname globs for `blockHosts` / `allowHosts`. `*` matches any run of characters (dots included), and a
 * leading `*.` also matches the bare domain: `*.sentry.io` covers `sentry.io`, `o1.ingest.sentry.io` and
 * `browser.sentry.io`. Matching is case-insensitive and ignores a trailing dot.
 */
export function compileHostGlob(glob: string): RegExp {
  let pattern = glob.trim().toLowerCase().replace(/\.$/, '');
  let optionalSubdomain = false;
  if (pattern.startsWith('*.')) {
    optionalSubdomain = true;
    pattern = pattern.slice(2);
  }
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${optionalSubdomain ? '(?:.*\\.)?' : ''}${body}$`);
}

export function hostOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'ws:' && protocol !== 'wss:') return null;
    return hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

export interface HostBlockerOptions {
  blockHosts: readonly string[];
  allowHosts: readonly string[];
  /** URLs whose hosts are never blocked (the app and the dev server). */
  ownUrls: readonly string[];
}

/**
 * A predicate over request URLs: true when the request goes to a blocked host. Only http(s)/ws(s) URLs can be
 * blocked (`data:`, `blob:` never are); `allowHosts` and the app's own hosts win over `blockHosts`.
 */
export function hostBlocker(options: HostBlockerOptions): (url: string) => boolean {
  const block = options.blockHosts.map(compileHostGlob);
  if (block.length === 0) return () => false;
  const allow = options.allowHosts.map(compileHostGlob);
  const own = new Set(options.ownUrls.map(hostOf).filter((h): h is string => h !== null));
  return (url) => {
    const host = hostOf(url);
    if (host === null || own.has(host)) return false;
    if (allow.some((re) => re.test(host))) return false;
    return block.some((re) => re.test(host));
  };
}

import { ConfigError } from './config.js';

/** A multi-line message (`- field` bullets after a headline) as one line, every line kept: `a; b; c`. */
export function flatten(message: string): string {
  return message
    .split('\n')
    .map((l) => l.trim().replace(/^- /, ''))
    .filter(Boolean)
    .join('; ');
}

/**
 * One readable line for a failure. Node's connect errors for `localhost` (tried over IPv4 and IPv6)
 * are AggregateErrors with an empty message, so fall back to the error code.
 */
export function firstLine(err: unknown): string {
  if (err instanceof Error) {
    const line = err.message.split('\n')[0];
    if (line) return line;
    const code = (err as NodeJS.ErrnoException).code;
    if (code) return code;
    if (err instanceof AggregateError && err.errors.length > 0) return firstLine(err.errors[0]);
    return err.name;
  }
  return String(err).split('\n')[0] || 'unknown error';
}

/** A config error keeps every invalid field (flattened to one line); anything else is cut to its first line. */
export function describeError(err: unknown): string {
  return err instanceof ConfigError ? flatten(err.message) : firstLine(err);
}

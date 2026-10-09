import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The OpenRouter key for live tests: `VP_LIVE_OPENROUTER_API_KEY`, else `OPENROUTER_API_KEY` in the worktree's `.env`. */
export function liveKey(): string | null {
  const fromEnv = process.env.VP_LIVE_OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const m = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^"'\s#]+)/m.exec(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export const LIVE_KEY = liveKey();
export const STILLS = path.join(ROOT, 'test/fixtures/stills');
export const still = (name: 'clean' | 'loading' | 'error' | 'blank'): string => path.join(STILLS, `${name}.png`);

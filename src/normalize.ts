import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DoctorReport } from './doctor.js';

/** An absolute directory and the placeholder it is replaced with (`/tmp/x/app` -> `<repo>`). */
export interface PathRoot {
  path: string;
  label: string;
}

export interface NormalizeOptions {
  /** Directories to replace, wherever they appear in the text. Each is also tried in its realpath form. */
  roots?: PathRoot[];
  /** Also replace the OS temp dir (`<tmp>`) and the home dir (`<home>`). Default true. */
  system?: boolean;
}

/**
 * Strip everything that varies between runs and machines from text: absolute directories, ports, hashes,
 * timings and tool versions. What is left is stable, so it can be checked in and diffed.
 *
 *  - roots, then the temp and home dirs: `<repo>`, `<tmp>`, `<home>`, ...
 *  - `localhost:5173`, `127.0.0.1:3000`, `app.test:8080` -> `...:<port>`
 *  - 7 to 40 hex digits (git hashes, short or long) -> `<hash>`
 *  - `123 ms` -> `<n> ms`
 *  - `Chromium 130.0.6723.58`, `Playwright 1.64.0`, `ffmpeg 7.1`, ... -> `Chromium <version>`
 */
export function normalizeText(text: string, options: NormalizeOptions = {}): string {
  const roots = [...(options.roots ?? [])];
  if (options.system !== false) {
    roots.push({ path: os.tmpdir(), label: '<tmp>' }, { path: os.homedir(), label: '<home>' });
  }
  const spellings: PathRoot[] = [];
  for (const root of roots) {
    if (!root.path || root.path === path.sep) continue;
    const resolved = path.resolve(root.path);
    spellings.push({ path: resolved, label: root.label });
    try {
      const real = fs.realpathSync(resolved);
      if (real !== resolved) spellings.push({ path: real, label: root.label });
    } catch {
      // The directory is gone or never existed; the plain spelling still applies.
    }
  }
  // Longest first, so `/tmp/x/app` becomes `<repo>` before `/tmp` becomes `<tmp>`.
  spellings.sort((a, b) => b.path.length - a.path.length);

  let out = text;
  for (const { path: dir, label } of spellings) out = out.split(dir).join(label);
  return out
    .replace(/((?:localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)):\d{2,5}\b/gi, '$1:<port>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>')
    .replace(/\d+ ms\b/g, '<n> ms')
    .replace(/\b(Chromium|Chrome|Firefox|WebKit|Playwright|Vite|Node(?:\.js)?|ffmpeg|visual-proof) v?\d+(?:\.\d+)+\S*/gi, '$1 <version>');
}

/**
 * The doctor report with its timestamp and every machine-specific detail replaced, ready to be checked in as a
 * golden file. Same shape as the report.
 */
export function normalizeDoctorReport(report: DoctorReport, options: NormalizeOptions = {}): DoctorReport {
  const text = normalizeText(JSON.stringify({ ...report, at: '<timestamp>' }, null, 2), options);
  return JSON.parse(text) as DoctorReport;
}

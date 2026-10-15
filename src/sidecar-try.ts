import fs from 'node:fs';
import path from 'node:path';
import { Browser, type Capturer, type ScenarioPlan, type ScenarioResult } from './browser.js';
import { CONFIG_FILE_NAME, ConfigError, loadConfig, type Config } from './config.js';
import { EXIT } from './exit.js';
import { resolveDirs, statusFiles, type Dirs } from './paths.js';
import { routeSlug } from './finish.js';
import { loadLayeredParams } from './resolve/param-tiers.js';
import { hasParams } from './resolve/route-pattern.js';
import { concretePath, joinUrl } from './resolve/routes.js';
import { formatSidecarError, loadSidecar, validateSidecar, type SidecarStep } from './sidecar.js';
import { describeError } from './text.js';
import { Timeline } from './timeline.js';
import { triage } from './triage.js';

/**
 * `visual-proof sidecar try <file>` (v0.13): replay one sidecar scenario now, against the running app, in a browser of
 * its own. No watcher, no commit, no frame record: each step's outcome, the stills (written under the scratch dir) and
 * the time it took, so an agent can fix a scenario in seconds instead of committing and waiting for the watcher.
 */

export interface TriedStep {
  line: number;
  text: string;
  verb: SidecarStep['verb'];
  status: 'ok' | 'failed' | 'skipped';
  ms?: number;
  reason?: string;
}

export interface TriedStill {
  name: string;
  status: string;
  reasons: string[];
  /** Absolute path of the PNG. */
  png: string;
}

export interface SidecarTryResult {
  /** Config-relative path of the scenario. */
  file: string;
  name: string;
  /** Every step passed and every still is clean. */
  ok: boolean;
  /** Parse and config problems (`file:line: message`); nothing ran when there are any. */
  errors: string[];
  steps: TriedStep[];
  stills: TriedStill[];
  failure?: { line: number; text: string; reason: string };
  ms: number;
}

export interface SidecarTryOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: Dirs;
  /** Replaces the browser (tests). */
  launch?: (config: Config) => Promise<Capturer>;
  log?: (message: string) => void;
}

/** Run one scenario; `file` is config-relative. */
export async function trySidecar(config: Config, file: string, opts: SidecarTryOptions = {}): Promise<SidecarTryResult> {
  const started = Date.now();
  const dirs = opts.dirs ?? resolveDirs(opts.env); // only the scratch dir is written: stills go under it, not to the artifacts
  const sidecar = loadSidecar(config.repoDir, file);
  const result: SidecarTryResult = { file, name: sidecar.name, ok: false, errors: [], steps: [], stills: [], ms: 0 };
  const errors = validateSidecar(sidecar, config);
  if (errors.length > 0) {
    result.errors = errors.map((e) => formatSidecarError(file, e));
    result.ms = Date.now() - started;
    return result;
  }

  // The same params chain the watcher starts from: session params, the seed file, routeParams; then what the watcher
  // filled before (from a list endpoint or by link discovery), as its frames record it.
  const params = loadLayeredParams(config, statusFiles(dirs).sessionParams).params;
  const timeline = new Timeline(dirs.scratchDir, config.maxFrames);
  const gotos: ScenarioPlan['gotos'] = new Map();
  for (const step of sidecar.steps) {
    if (step.verb !== 'goto') continue;
    const concrete = concretePath(step.target, params);
    const filled = concrete.ok ? concrete.path : hasParams(step.target) ? timeline.list().filter((f) => f.routeKey === step.target).at(-1)?.route : undefined;
    gotos.set(
      step.line,
      filled
        ? { path: filled, url: joinUrl(config.appUrl, filled) }
        : { error: `cannot fill ${step.target}: ${concrete.ok ? 'no value' : concrete.reason}; set it with visual-proof params set` },
    );
  }

  let browser: Capturer | null = null;
  let ran: ScenarioResult;
  try {
    browser = await (opts.launch ?? ((c: Config) => Browser.launch(c, { log: opts.log })))(config);
    await browser.warm();
    if (!browser.runScenario) throw new Error('this browser cannot run scenarios');
    ran = await browser.runScenario({ file, name: sidecar.name, steps: sidecar.steps, gotos });
  } catch (err) {
    result.errors.push(`could not run the scenario: ${describeError(err)}`);
    result.ms = Date.now() - started;
    return result;
  } finally {
    await browser?.close().catch(() => {});
  }

  const timings = new Map((ran.steps ?? []).map((s) => [s.line, s.ms]));
  const failedAt = ran.failure?.line;
  for (const step of sidecar.steps) {
    const status: TriedStep['status'] = failedAt === undefined || step.line < failedAt ? 'ok' : step.line === failedAt ? 'failed' : 'skipped';
    const ms = timings.get(step.line);
    result.steps.push({
      line: step.line,
      text: step.text,
      verb: step.verb,
      status,
      ...(ms !== undefined && status !== 'skipped' ? { ms } : {}),
      ...(status === 'failed' ? { reason: ran.failure!.reason } : {}),
    });
  }
  if (ran.failure) result.failure = ran.failure;

  const outDir = path.join(dirs.scratchDir, 'try');
  fs.mkdirSync(outDir, { recursive: true });
  for (const still of ran.stills) {
    const verdict = triage(still.signals);
    const png = path.join(outDir, `${routeSlug(`${sidecar.name}-${still.failed ? 'failed' : still.name}`)}.png`);
    fs.writeFileSync(png, still.png);
    result.stills.push({ name: still.failed ? `${still.name} (step failed)` : still.name, status: verdict.status, reasons: verdict.reasons, png });
  }
  result.ok = !ran.failure && result.stills.every((s) => s.status === 'clean');
  result.ms = Date.now() - started;
  return result;
}

/** The text report: one line per step, then the stills and a summary. */
export function renderTry(result: SidecarTryResult, appUrl: string): string {
  const lines = [`sidecar ${result.file} (${result.name}) against ${appUrl}`];
  if (result.errors.length > 0) {
    for (const error of result.errors) lines.push(`  error ${error}`);
    lines.push(`not run: ${result.errors.length} problem(s)`);
    return `${lines.join('\n')}\n`;
  }
  const width = Math.max(...result.steps.map((s) => String(s.line).length));
  for (const step of result.steps) {
    const mark = step.status === 'ok' ? 'ok  ' : step.status === 'failed' ? 'FAIL' : 'skip';
    const ms = step.ms !== undefined ? ` (${step.ms} ms)` : '';
    lines.push(`  ${mark} line ${String(step.line).padStart(width)}  ${step.text}${ms}${step.reason ? `: ${step.reason}` : ''}`);
  }
  for (const still of result.stills) {
    lines.push(`  still ${still.name}: ${still.status}${still.reasons.length > 0 ? ` (${still.reasons.join('; ')})` : ''} -> ${still.png}`);
  }
  const passed = result.steps.filter((s) => s.status === 'ok').length;
  const seconds = (result.ms / 1000).toFixed(1);
  if (result.failure) {
    lines.push(`failed at ${result.file}:${result.failure.line} ${result.failure.text}: ${result.failure.reason} (${passed}/${result.steps.length} steps passed, ${seconds} s)`);
  } else if (!result.ok) {
    lines.push(`every step passed, but a still is not clean (${seconds} s); finish would fail on it`);
  } else {
    lines.push(`ok: ${result.steps.length} steps, ${result.stills.length} still(s) in ${seconds} s`);
  }
  return `${lines.join('\n')}\n`;
}

export interface SidecarTryCommandContext {
  configPath?: string;
  file: string;
  json?: boolean;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  launch?: SidecarTryOptions['launch'];
}

/** `visual-proof sidecar try <file> [--json]`: 0 when every step passed and every still is clean, 1 otherwise, 3 setup error. */
export async function sidecarTryCommand(ctx: SidecarTryCommandContext): Promise<number> {
  const out = ctx.out ?? ((t) => process.stdout.write(t));
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  const cwd = ctx.cwd ?? process.cwd();
  let config: Config;
  try {
    config = loadConfig({ configPath: path.resolve(cwd, ctx.configPath ?? CONFIG_FILE_NAME), cwd, env: ctx.env });
  } catch (e) {
    err(`visual-proof sidecar try: ${describeError(e)}\n`);
    return e instanceof ConfigError ? EXIT.SETUP : EXIT.INTERNAL;
  }
  const abs = path.resolve(cwd, ctx.file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    err(`visual-proof sidecar try: no such file: ${ctx.file}\n`);
    return EXIT.SETUP;
  }
  const file = path.relative(config.repoDir, abs).split(path.sep).join('/');
  if (file.startsWith('../')) {
    err(`visual-proof sidecar try: ${ctx.file} is outside the config directory ${config.repoDir}\n`);
    return EXIT.SETUP;
  }
  const result = await trySidecar(config, file, { env: ctx.env, launch: ctx.launch });
  out(ctx.json ? `${JSON.stringify(result, null, 2)}\n` : renderTry(result, config.appUrl));
  return result.ok ? EXIT.OK : EXIT.FAILURES;
}

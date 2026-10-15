import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { BEFORE_SCRATCH, mergeBase, type MergeBase } from './before-base.js';
import { Browser, type Capturer, type ScenarioPlan } from './browser.js';
import { CONFIG_FILE_NAME, ConfigError, loadConfig, type Config } from './config.js';
import { EXIT } from './exit.js';
import { runFinish } from './finish.js';
import { scenarioHash } from './focus.js';
import { headTree, showAtHead } from './git.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { loadLayeredParams } from './resolve/param-tiers.js';
import { hasParams } from './resolve/route-pattern.js';
import { concretePath, joinUrl } from './resolve/routes.js';
import { parseSidecar, sidecarRoute } from './sidecar.js';
import { readStatusFile } from './status.js';
import { describeError } from './text.js';
import { Timeline } from './timeline.js';
import { triage } from './triage.js';

const run = promisify(execFile);

/** Impact routes that fail where the change renders are captured at the merge-base too, at most this many. */
export const MAX_IMPACT_BEFORE = 10;
const WRAPPER_CONFIG = '.visual-proof-before.vite.config.mjs';
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];

/** A dev server serving the merge-base checkout. */
export interface DevServer {
  /** Where the browser's dev-server requests are sent, e.g. `https://127.0.0.1:51234`. */
  target: string;
  stop(): Promise<void>;
}

export interface BeforeOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: Dirs;
  log?: (message: string) => void;
  /** Replaces the worktree + Vite start (tests). */
  startServer?: (config: Config, base: MergeBase, dirs: Dirs) => Promise<DevServer>;
  /** Replaces the browser (tests). */
  launch?: (config: Config, devServer: DevServer) => Promise<Capturer>;
}

export interface BeforeCapture {
  label: string;
  status: string;
  frameId?: string;
  error?: string;
}

export interface BeforeResult {
  ok: boolean;
  base: MergeBase | null;
  captures: BeforeCapture[];
  notes: string[];
  /** Set when nothing could be captured at all. */
  error?: string;
}

/**
 * Capture the headlines `finish` will show (and impact routes that fail where the change renders) with the frontend
 * at the merge-base: a git worktree at that commit served by its own Vite, the browser's dev-server requests sent to
 * it. The backend and its data stay as they are. Frames go to their own timeline, keyed by the merge-base tree.
 */
export async function runBefore(config: Config, opts: BeforeOptions = {}): Promise<BeforeResult> {
  const dirs = opts.dirs ?? resolveDirs(opts.env);
  ensureDirs(dirs);
  const log = opts.log ?? (() => {});
  const result: BeforeResult = { ok: false, base: null, captures: [], notes: [] };

  if (config.before.mode === 'off') return { ...result, ok: true, notes: ['before.mode is "off"'] };
  const status = readStatusFile(statusFiles(dirs).status);
  const base = await mergeBase(config.repoDir, config.baseRef, status?.anchor);
  if (!base) return { ...result, error: `no merge-base with ${config.baseRef}` };
  result.base = base;

  const plan = await runFinish(config, { dirs, env: opts.env, planOnly: true });
  if (plan.noScreenChanges) return { ...result, ok: true, notes: ['no screen changes: nothing to compare'] };
  const tree = await headTree(config.repoDir);
  const head = new Timeline(dirs.scratchDir, config.maxFrames);
  const headlines = plan.routes.filter((r) => r.role !== 'impact');
  const failingImpact = plan.routes
    .filter((r) => r.role === 'impact' && r.via === 'screen')
    .filter((r) => {
      const frame = tree ? head.latestAtTree(r.route, tree) : undefined;
      return frame && frame.status !== 'clean' && Array.isArray(frame.renderedFiles) && r.sourceFiles.some((f) => frame.renderedFiles!.includes(f));
    });
  if (failingImpact.length > MAX_IMPACT_BEFORE) result.notes.push(`${failingImpact.length - MAX_IMPACT_BEFORE} failing impact route(s) over ${MAX_IMPACT_BEFORE} not captured`);
  const routes = [...headlines.filter((r) => !r.scenario), ...failingImpact.slice(0, MAX_IMPACT_BEFORE)];
  const scenarioFiles = [...new Set(headlines.flatMap((r) => (r.scenario ? [r.scenario.file] : [])))];
  if (routes.length === 0 && scenarioFiles.length === 0) return { ...result, ok: true, notes: ['no headlines to capture'] };

  const seed = loadLayeredParams(config, statusFiles(dirs).sessionParams);
  const concrete = (route: string): string | null => {
    if (!hasParams(route)) return route;
    const filled = concretePath(route, seed.params);
    if (filled.ok) return filled.path;
    return head.latest(route)?.route ?? null; // filled by discovery or a list endpoint at HEAD: the same record
  };

  let server: DevServer | null = null;
  let browser: Capturer | null = null;
  const timeline = new Timeline(path.join(dirs.scratchDir, BEFORE_SCRATCH), config.maxFrames);
  const sessionId = `before-${Date.now().toString(36)}`;
  try {
    log(`before: serving the frontend at ${base.commit.slice(0, 8)}`);
    server = await (opts.startServer ?? startDevServer)(config, base, dirs);
    browser = await (opts.launch ?? launchBrowser)(config, server);
    await browser.warm();

    for (const route of routes) {
      const label = route.route;
      const target = concrete(route.route);
      if (target === null) {
        result.captures.push({ label, status: 'skipped', error: 'route params unfilled at HEAD too' });
        continue;
      }
      try {
        const shot = await browser.capture(joinUrl(config.appUrl, target));
        const verdict = triage(shot.signals);
        const frame = timeline.append(
          {
            sessionId,
            route: target,
            routeKey: route.routeKey,
            at: new Date().toISOString(),
            treeHash: base.tree,
            trigger: 'screen',
            sourceFile: route.sourceFiles[0],
            status: verdict.status,
            reasons: verdict.reasons,
            renderedFiles: shot.renderedFiles ?? null,
          },
          shot.png,
        );
        result.captures.push({ label, status: frame.status, frameId: frame.id });
      } catch (err) {
        result.captures.push({ label, status: 'failed', error: describeError(err) });
      }
    }

    for (const file of scenarioFiles) {
      const text = await showAtHead(config.repoDir, file);
      if (text === null || !browser.runScenario) continue;
      const sidecar = parseSidecar(text, file);
      const gotos: ScenarioPlan['gotos'] = new Map();
      for (const step of sidecar.steps) {
        if (step.verb !== 'goto') continue;
        const target = concrete(step.target);
        gotos.set(step.line, target === null ? { error: `cannot fill ${step.target}: params unfilled` } : { path: target, url: joinUrl(config.appUrl, target) });
      }
      try {
        const ran = await browser.runScenario({ file, name: sidecar.name, steps: sidecar.steps, gotos });
        for (const still of ran.stills) {
          const verdict = triage(still.signals);
          const frame = timeline.append(
            {
              sessionId,
              route: sidecarRoute(file, still.name),
              routeKey: sidecarRoute(file, still.name),
              at: still.at,
              treeHash: base.tree,
              trigger: 'sidecar',
              sourceFile: file,
              status: verdict.status,
              reasons: verdict.reasons,
              renderedFiles: still.renderedFiles,
              steps: still.steps,
              scenarioHash: scenarioHash(text),
            },
            still.png,
          );
          result.captures.push({ label: `sidecar ${sidecar.name} / ${still.name}`, status: frame.status, frameId: frame.id });
        }
      } catch (err) {
        result.captures.push({ label: `sidecar ${sidecar.name}`, status: 'failed', error: describeError(err) });
      }
    }
  } catch (err) {
    result.error = describeError(err);
  } finally {
    await browser?.close().catch(() => {});
    await server?.stop().catch(() => {});
  }
  // A before frame that shows an error is still a before frame (the screen may not have existed yet): only a capture
  // that produced nothing counts against the run.
  result.ok = result.error === undefined && result.captures.every((c) => c.frameId !== undefined || c.status === 'skipped');
  return result;
}

async function launchBrowser(config: Config, devServer: DevServer): Promise<Capturer> {
  return Browser.launch(config, { devServer: { host: new URL(config.viteUrl).host, target: devServer.target } });
}

/** A worktree at the merge-base, the configured links symlinked in, and its own Vite on a free port. */
export async function startDevServer(config: Config, base: MergeBase, dirs: Dirs): Promise<DevServer> {
  const worktree = await prepareWorktree(config, base, dirs);
  const viteConfig = findViteConfig(worktree, config.before.viteConfig);
  const port = await freePort();
  const origin = new URL(config.viteUrl).origin;
  fs.writeFileSync(
    path.join(worktree, WRAPPER_CONFIG),
    [
      "import { loadConfigFromFile, mergeConfig } from 'vite';",
      'export default async (env) => {',
      `  const loaded = await loadConfigFromFile(env, ${JSON.stringify(viteConfig)});`,
      '  return mergeConfig(loaded?.config ?? {}, {',
      `    cacheDir: ${JSON.stringify(path.join(worktree, '.vite-before'))},`,
      '    clearScreen: false,',
      // The linked node_modules resolve to the checkout's real path, outside the worktree.
      `    server: { host: '127.0.0.1', port: ${port}, strictPort: true, hmr: false, origin: ${JSON.stringify(origin)}, fs: { allow: ${JSON.stringify([worktree, config.repoDir])} } },`,
      '  });',
      '};',
      '',
    ].join('\n'),
  );
  const require = createRequire(path.join(worktree, 'package.json'));
  const vitePackage = require.resolve('vite/package.json');
  const bin = (JSON.parse(fs.readFileSync(vitePackage, 'utf8')) as { bin?: string | Record<string, string> }).bin;
  const binPath = path.resolve(path.dirname(vitePackage), typeof bin === 'string' ? bin : (bin?.vite ?? 'bin/vite.js'));
  const logFile = path.join(dirs.statusDir, 'before-vite.log');
  const out = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [binPath, '--config', WRAPPER_CONFIG], { cwd: worktree, stdio: ['ignore', out, out], detached: false });
  fs.closeSync(out);
  const stop = () => stopChild(child);
  try {
    const target = await waitForServer(port, child, config.before.startTimeoutMs, logFile);
    return { target, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

async function prepareWorktree(config: Config, base: MergeBase, dirs: Dirs): Promise<string> {
  const worktree = path.join(dirs.scratchDir, BEFORE_SCRATCH, 'worktree');
  const git = (args: string[], cwd = config.repoDir) => run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  const current = fs.existsSync(path.join(worktree, '.git')) ? await git(['rev-parse', 'HEAD'], worktree).then((r) => r.stdout.trim(), () => null) : null;
  if (current === null) {
    fs.rmSync(worktree, { recursive: true, force: true });
    await git(['worktree', 'prune']);
    await git(['worktree', 'add', '--force', '--detach', worktree, base.commit]);
  } else if (current !== base.commit) {
    await git(['checkout', '--force', '--detach', base.commit], worktree);
  }
  for (const link of config.before.links) {
    const source = path.join(config.repoDir, link);
    const target = path.join(worktree, link);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target);
  }
  return worktree;
}

function findViteConfig(worktree: string, configured: string | undefined): string {
  const candidates = configured ? [configured] : VITE_CONFIGS;
  const found = candidates.map((file) => path.join(worktree, file)).find((file) => fs.existsSync(file));
  if (!found) throw new Error(`no Vite config at the merge-base (looked for ${candidates.join(', ')}; set before.viteConfig)`);
  return found;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** The first of https and http on which Vite answers `/@vite/client`. */
async function waitForServer(port: number, child: ChildProcess, timeoutMs: number, logFile: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null = null;
  child.once('exit', (code) => {
    exited = code ?? -1;
  });
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`the merge-base Vite exited with code ${exited}; see ${logFile}`);
    for (const scheme of ['https', 'http']) {
      if (await answers(`${scheme}://127.0.0.1:${port}/@vite/client`)) return `${scheme}://127.0.0.1:${port}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the merge-base Vite did not answer within ${Math.round(timeoutMs / 1000)} s; see ${logFile}`);
}

function answers(url: string): Promise<boolean> {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    // The dev server's certificate is self-signed.
    const request = client.get(url, { rejectUnauthorized: false, timeout: 2000 }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await gone;
  clearTimeout(timer);
}

// ---- CLI --------------------------------------------------------------------

export interface BeforeCommandContext {
  configPath?: string;
  json?: boolean;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** `visual-proof before [--json]`: 0 when every headline has a before frame, 1 when one could not be captured, 3 setup error. */
export async function beforeCommand(ctx: BeforeCommandContext): Promise<number> {
  const out = ctx.out ?? ((t) => process.stdout.write(t));
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  let config: Config;
  try {
    const cwd = ctx.cwd ?? process.cwd();
    config = loadConfig({ configPath: path.resolve(cwd, ctx.configPath ?? CONFIG_FILE_NAME), cwd, env: ctx.env });
  } catch (e) {
    err(`visual-proof before: ${describeError(e)}\n`);
    return e instanceof ConfigError ? EXIT.SETUP : EXIT.INTERNAL;
  }
  const result = await runBefore(config, { env: ctx.env, log: (m) => err(`visual-proof ${m}\n`) });
  if (ctx.json) {
    out(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const at = result.base ? ` at merge-base ${result.base.commit.slice(0, 8)}` : '';
    for (const c of result.captures) out(`before ${c.label}${at}: ${c.status}${c.error ? ` (${c.error})` : ''}\n`);
    for (const note of result.notes) out(`note: ${note}\n`);
  }
  if (result.error) {
    err(`visual-proof before: ${result.error}\n`);
    return result.base ? EXIT.FAILURES : EXIT.SETUP;
  }
  return result.ok ? EXIT.OK : EXIT.FAILURES;
}



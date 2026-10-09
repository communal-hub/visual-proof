import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig, type Config } from '../../src/config.js';
import { runFinish, type FinishOptions, type FinishResult } from '../../src/finish.js';
import { resolveDirs, statusFiles, type Dirs } from '../../src/paths.js';
import { Timeline } from '../../src/timeline.js';
import { startWatch, type FrameEvent, type WatchHandle, type WatchOptions } from '../../src/watch.js';

const execFileAsync = promisify(execFile);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures/vite-vue');

export interface Harness {
  /**
   * Throwaway git repo: a copy of the fixture with `node_modules` symlinked. `main` holds the
   * initial commit (the config's `baseRef`) and work happens on the `work` branch, so
   * `main...HEAD` is meaningful for `finish`.
   */
  dir: string;
  port: number;
  appUrl: string;
  configPath: string;
  config: Config;
  /** Env with VISUAL_PROOF_STATUS_DIR / ARTIFACT_DIR (and scratch under status) pointing at temp dirs. */
  env: NodeJS.ProcessEnv;
  dirs: Dirs;
  /** Every `frame` event from the session started with {@link Harness.start}, oldest first. */
  frames: FrameEvent[];
  /** `refused` / `discarded` / `error` events, in arrival order. */
  events: { refused: unknown[]; discarded: unknown[]; errors: Error[] };
  watch: WatchHandle | null;
  /** Start the watcher (real Chromium, real HMR client, real fs watch) against this fixture. */
  start(options?: WatchOptions): Promise<WatchHandle>;
  stopWatch(): Promise<void>;
  /** Read-modify-write a repo-relative file. */
  edit(file: string, fn: (content: string) => string): void;
  /** Write `.visual-proof/sidecars/<name>.vp` (the default sidecar glob) and return its repo-relative path. */
  writeSidecar(name: string, text: string): string;
  /** `git add -A && git commit`; returns the new `HEAD^{tree}`. */
  commitAll(message?: string): string;
  /** Run git in the repo and return trimmed stdout. */
  git(...args: string[]): string;
  /** Run the module-level `finish` against this repo and its status/artifact dirs. */
  finish(options?: FinishOptions): Promise<FinishResult>;
  /** Run the real CLI (`src/cli.ts` under tsx) with `--config` pointing at this repo; never throws on a non-zero exit. */
  cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Stop the Vite dev server (it removes the freshness marker on close), leaving everything else running. */
  stopDevServer(): Promise<void>;
  /**
   * Resolve with the first frame matching `predicate`, among frames that arrive after this call
   * (or from index `options.from` of {@link Harness.frames}). Rejects on timeout.
   */
  waitForFrame(predicate: (event: FrameEvent) => boolean, timeoutMs?: number, options?: { from?: number }): Promise<FrameEvent>;
  /** Resolve on the next `name` event from the watcher (`refused`, `discarded`, `batch`, ...). */
  waitForEvent<T = unknown>(name: string, timeoutMs?: number): Promise<T>;
  /** Scratch-dir timeline of the session (for `latestAtTree` and friends). */
  timeline(): Timeline;
  /** Stop the watcher, the dev server, and delete every temp dir. Safe to call twice. */
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  /** Fixture config file to start from (default `visual-proof.config.json`), e.g. `visual-proof.param-sources.config.json`. */
  configFile?: string;
  /** Fixture config keys to override before the real port is applied. */
  config?: Record<string, unknown>;
  /** Give the dev server its own empty dependency cache, so its first page load really is a cold start. */
  freshViteCache?: boolean;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-int-')));
  const dir = path.join(root, 'app');
  const statusDir = path.join(root, 'status');
  const artifactDir = path.join(root, 'artifacts');
  fs.mkdirSync(statusDir);
  fs.mkdirSync(artifactDir);

  copyFixture(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Harness');
  git(dir, 'config', 'user.email', 'harness@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  git(dir, 'checkout', '-q', '-b', 'work');

  let vite: ViteProcess | null = null;
  let watch: WatchHandle | null = null;
  let cleaned = false;
  const cleanupAll = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await watch?.stop().catch(() => {});
    await vite?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  };

  try {
    const port = await freePort();
    vite = await startVite(dir, port, options.freshViteCache ? path.join(root, 'vite-cache') : undefined);

    const appUrl = `http://localhost:${port}`;
    const fixtureConfig = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, options.configFile ?? 'visual-proof.config.json'), 'utf8')) as Record<string, unknown>;
    const configPath = path.join(dir, 'visual-proof.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...fixtureConfig, appUrl, viteUrl: appUrl, decisions: { enabled: false }, ...options.config }, null, 2),
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VISUAL_PROOF_STATUS_DIR: statusDir,
      VISUAL_PROOF_ARTIFACT_DIR: artifactDir,
    };
    delete env.VISUAL_PROOF_SCRATCH_DIR;
    delete env.VISUAL_PROOF_APP_URL;
    delete env.VISUAL_PROOF_VITE_URL;
    const config = loadConfig({ configPath, env });
    const dirs = resolveDirs(env);

    const frames: FrameEvent[] = [];
    const events = { refused: [] as unknown[], discarded: [] as unknown[], errors: [] as Error[] };

    const harness: Harness = {
      dir,
      port,
      appUrl,
      configPath,
      config,
      env,
      dirs,
      frames,
      events,
      get watch() {
        return watch;
      },
      async start(startOptions = {}) {
        if (watch) throw new Error('watcher already started');
        const handle = await startWatch(config, { env, ...startOptions });
        handle.events.on('frame', (e: FrameEvent) => frames.push(e));
        handle.events.on('refused', (e) => events.refused.push(e));
        handle.events.on('discarded', (e) => events.discarded.push(e));
        handle.events.on('error', (e: Error) => events.errors.push(e));
        watch = handle;
        return handle;
      },
      async stopWatch() {
        const handle = watch;
        watch = null;
        await handle?.stop();
      },
      edit(file, fn) {
        const target = path.join(dir, file);
        fs.writeFileSync(target, fn(fs.readFileSync(target, 'utf8')));
      },
      writeSidecar(name, text) {
        const rel = `.visual-proof/sidecars/${name}.vp`;
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
        return rel;
      },
      git: (...args) => git(dir, ...args),
      finish: (finishOptions = {}) => runFinish(config, { env, ...finishOptions }),
      async cli(...args) {
        try {
          const { stdout, stderr } = await execFileAsync(
            process.execPath,
            ['--import', 'tsx', path.join(REPO_ROOT, 'src/cli.ts'), ...args, '--config', configPath],
            { cwd: REPO_ROOT, env, timeout: 60_000 },
          );
          return { code: 0, stdout, stderr };
        } catch (err) {
          const e = err as { code?: number; stdout?: string; stderr?: string };
          return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
        }
      },
      async stopDevServer() {
        await vite?.stop();
      },
      commitAll(message = 'change') {
        git(dir, 'add', '-A');
        git(dir, 'commit', '-q', '--allow-empty', '-m', message);
        return git(dir, 'rev-parse', 'HEAD^{tree}');
      },
      waitForFrame(predicate, timeoutMs = 10_000, waitOptions = {}) {
        const handle = watch;
        if (!handle) return Promise.reject(new Error('watcher not started'));
        const from = waitOptions.from ?? frames.length;
        const already = frames.slice(from).find(predicate);
        if (already) return Promise.resolve(already);
        return new Promise((resolve, reject) => {
          const done = (fn: () => void): void => {
            clearTimeout(timer);
            handle.events.off('frame', onFrame);
            fn();
          };
          const onFrame = (event: FrameEvent): void => {
            if (predicate(event)) done(() => resolve(event));
          };
          const timer = setTimeout(
            () => done(() => reject(new Error(`no matching frame within ${timeoutMs} ms; saw ${JSON.stringify(frames.slice(from).map((f) => [f.frame.route, f.frame.status, ...f.frame.reasons]))}`))),
            timeoutMs,
          );
          handle.events.on('frame', onFrame);
        });
      },
      waitForEvent<T>(name: string, timeoutMs = 10_000) {
        const handle = watch;
        if (!handle) return Promise.reject(new Error('watcher not started'));
        return new Promise<T>((resolve, reject) => {
          const emitter: EventEmitter = handle.events;
          const onEvent = (value: T): void => {
            clearTimeout(timer);
            resolve(value);
          };
          const timer = setTimeout(() => {
            emitter.off(name, onEvent);
            reject(new Error(`no "${name}" event within ${timeoutMs} ms`));
          }, timeoutMs);
          emitter.once(name, onEvent);
        });
      },
      timeline() {
        return new Timeline(dirs.scratchDir, config.maxFrames);
      },
      cleanup: cleanupAll,
    };
    return harness;
  } catch (err) {
    await cleanupAll();
    throw err;
  }
}

/** Convenience for tests that only need the status-dir file paths of a harness. */
export function harnessFiles(h: Pick<Harness, 'dirs'>): ReturnType<typeof statusFiles> {
  return statusFiles(h.dirs);
}

// ---- fixture copy -----------------------------------------------------------

function copyFixture(dest: string): void {
  fs.cpSync(FIXTURE_DIR, dest, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return name !== 'node_modules' && name !== '.visual-proof';
    },
  });
  fs.symlinkSync(path.join(FIXTURE_DIR, 'node_modules'), path.join(dest, 'node_modules'), 'dir');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// ---- dev server -------------------------------------------------------------

interface ViteProcess {
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function startVite(dir: string, port: number, cacheDir?: string): Promise<ViteProcess> {
  const viteBin = path.join(dir, 'node_modules/vite/bin/vite.js');
  const child: ChildProcess = spawn(process.execPath, [viteBin, '--strictPort'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), FORCE_COLOR: '0', ...(cacheDir ? { VP_FIXTURE_CACHE_DIR: cacheDir } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  let exitCode: number | null = null;
  child.on('exit', (code) => (exitCode = code ?? -1));

  const stop = async (): Promise<void> => {
    if (exitCode !== null) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    if (exitCode === null) child.kill('SIGKILL');
  };

  const marker = path.join(dir, '.visual-proof/hot');
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(marker)) {
    if (exitCode !== null) throw new Error(`vite exited with code ${exitCode} before becoming ready:\n${output}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`vite did not write .visual-proof/hot within 60 s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // The marker is written on 'listening'; make sure requests are actually served.
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/@vite/client`);
      if (res.ok) break;
    } catch {
      // not accepting yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`vite not serving on port ${port}:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { stop };
}

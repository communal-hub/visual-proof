import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE_NAME, ConfigError, loadConfig, type Config } from './config.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { startWatch, type Status } from './watch.js';

export interface DaemonContext {
  configPath?: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- pid file ---------------------------------------------------------------

export function readPid(pidFile: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The live daemon's pid, removing a stale pid file as a side effect. */
export function livePid(pidFile: string): number | null {
  const pid = readPid(pidFile);
  if (pid === null) return null;
  if (isAlive(pid)) return pid;
  fs.rmSync(pidFile, { force: true });
  return null;
}

function removePidIfOwnedBy(pidFile: string, pid: number): void {
  if (readPid(pidFile) === pid) fs.rmSync(pidFile, { force: true });
}

function readStatus(statusFile: string): Partial<Status> | null {
  try {
    return JSON.parse(fs.readFileSync(statusFile, 'utf8')) as Partial<Status>;
  } catch {
    return null;
  }
}

function logTail(logFile: string, lines = 15): string {
  try {
    return fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'unknown error';
}

function loadContextConfig(ctx: DaemonContext): { config: Config; configPath: string } | { error: string } {
  const cwd = ctx.cwd ?? process.cwd();
  const configPath = path.resolve(cwd, ctx.configPath ?? CONFIG_FILE_NAME);
  try {
    return { config: loadConfig({ configPath, cwd, env: ctx.env }), configPath };
  } catch (err) {
    if (err instanceof ConfigError) return { error: oneLine(err) };
    return { error: oneLine(err) };
  }
}

// ---- watch (foreground) ------------------------------------------------------

/** Run the watcher in this process until SIGINT/SIGTERM, then shut down gracefully. */
export async function runWatch(ctx: DaemonContext): Promise<number> {
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  const loaded = loadContextConfig(ctx);
  if ('error' in loaded) {
    err(`visual-proof watch: ${loaded.error}\n`);
    return 1;
  }
  const dirs = resolveDirs(ctx.env);
  ensureDirs(dirs);
  const files = statusFiles(dirs);

  const existing = livePid(files.pid);
  if (existing !== null && existing !== process.pid) {
    err(`visual-proof watch: already running (pid ${existing})\n`);
    return 1;
  }
  fs.writeFileSync(files.pid, `${process.pid}\n`);

  let handle;
  try {
    handle = await startWatch(loaded.config, {
      env: ctx.env,
      dirs,
      log: process.stdout.isTTY ? (line) => process.stdout.write(`${line}\n`) : undefined,
    });
  } catch (e) {
    removePidIfOwnedBy(files.pid, process.pid);
    err(`visual-proof watch: failed to start: ${oneLine(e)}\n`);
    return 1;
  }

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

  await handle.stop().catch(() => {});
  removePidIfOwnedBy(files.pid, process.pid);
  return 0;
}

// ---- start --------------------------------------------------------------------

export async function startDaemon(ctx: DaemonContext): Promise<number> {
  const out = ctx.out ?? ((t) => process.stdout.write(t));
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  const fail = (reason: string, tail?: string): number => {
    err(`visual-proof start: ${reason}\n`);
    if (tail) err(`${tail}\n`);
    return 1;
  };

  try {
    const loaded = loadContextConfig(ctx);
    if ('error' in loaded) return fail(loaded.error);
    const dirs = resolveDirs(ctx.env);
    ensureDirs(dirs);
    const files = statusFiles(dirs);

    const running = livePid(files.pid);
    if (running !== null) {
      // Reattach: never a second browser.
      const status = readStatus(files.status) ?? { state: 'starting' };
      out(`${JSON.stringify(status)}\n`);
      return 0;
    }

    fs.rmSync(files.status, { force: true }); // so a stale 'ready' from a dead session cannot satisfy the wait below
    const logFd = fs.openSync(files.log, 'a');
    let child;
    try {
      child = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1] ?? '', 'watch', '--config', loaded.configPath],
        { detached: true, stdio: ['ignore', logFd, logFd], env: ctx.env, cwd: ctx.cwd ?? process.cwd() },
      );
    } finally {
      fs.closeSync(logFd);
    }
    child.unref();
    if (child.pid === undefined) {
      return fail(`could not spawn the watcher`, logTail(files.log));
    }
    const pid = child.pid;
    let exited: number | null = null;
    child.on('exit', (code, signal) => (exited = code ?? (signal ? 128 : 1)));
    child.on('error', () => (exited = 1));
    fs.writeFileSync(files.pid, `${pid}\n`);

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = readStatus(files.status);
      if (status?.state === 'ready' || status?.state === 'capturing') {
        out(`${JSON.stringify(status)}\n`);
        return 0;
      }
      if (exited !== null || status?.state === 'error') {
        removePidIfOwnedBy(files.pid, pid);
        return fail(`watcher failed to start: ${status?.lastError ?? `exited with code ${exited}`}`, logTail(files.log));
      }
      await sleep(POLL_MS);
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
    removePidIfOwnedBy(files.pid, pid);
    return fail(`watcher did not become ready within ${START_TIMEOUT_MS / 1000}s`, logTail(files.log));
  } catch (e) {
    return fail(oneLine(e));
  }
}

// ---- stop ---------------------------------------------------------------------

export async function stopDaemon(ctx: DaemonContext): Promise<number> {
  const out = ctx.out ?? ((t) => process.stdout.write(t));
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  const dirs: Dirs = resolveDirs(ctx.env);
  const files = statusFiles(dirs);

  const pid = livePid(files.pid);
  if (pid === null) {
    out(`${JSON.stringify({ state: 'stopped' })}\n`);
    return 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    err(`visual-proof stop: cannot signal pid ${pid}: ${oneLine(e)}\n`);
    return 1;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) await sleep(POLL_MS);

  if (isAlive(pid)) {
    err(`visual-proof stop: pid ${pid} ignored SIGTERM for ${STOP_TIMEOUT_MS / 1000}s; sending SIGKILL\n`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    await sleep(100);
    const status = readStatus(files.status);
    if (status && status.state !== 'stopped') {
      fs.writeFileSync(files.status, `${JSON.stringify({ ...status, state: 'stopped' }, null, 2)}\n`);
    }
  }
  fs.rmSync(files.pid, { force: true });
  out(`${JSON.stringify(readStatus(files.status) ?? { state: 'stopped' })}\n`);
  return 0;
}

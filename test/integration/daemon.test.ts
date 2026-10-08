import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isAlive, readPid } from '../../src/daemon.js';
import { statusFiles } from '../../src/paths.js';
import { createHarness, REPO_ROOT, type Harness } from './harness.js';

const execFileAsync = promisify(execFile);

let h: Harness;
let files: ReturnType<typeof statusFiles>;

beforeAll(async () => {
  h = await createHarness();
  files = statusFiles(h.dirs);
});
// A failed assertion must never leave a daemon (or its browser) behind, nor let one test's daemon
// be forgotten by the next test's pid file.
afterEach(async () => {
  await cli('stop');
});
afterAll(async () => {
  const pid = readPid(files.pid);
  if (pid !== null && isAlive(pid)) process.kill(pid, 'SIGKILL');
  try {
    execFileSync('pkill', ['-f', '--', `--config ${h.dir}`]);
  } catch {
    // nothing matched
  }
  await h?.cleanup();
});

/** Run the CLI from source under tsx, from the repo root (so `--import tsx` resolves in the detached child too). */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', path.join(REPO_ROOT, 'src/cli.ts'), ...args, '--config', h.configPath],
      { cwd: REPO_ROOT, env: h.env, timeout: 60_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function childPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('daemon lifecycle via the CLI', () => {
  it('start -> reattach -> capture -> stop', async () => {
    // start
    const started = await cli('start');
    expect(started.stderr).toBe('');
    expect(started.code).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ state: 'ready', trigger: 'fs-watch', barrier: 'vite-hmr' });

    const pid = readPid(files.pid)!;
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);
    expect(pid).not.toBe(process.pid);
    const status = JSON.parse(fs.readFileSync(files.status, 'utf8'));
    expect(status.state).toBe('ready');
    const sessionId = status.sessionId;

    // second start reattaches: same pid, same session, no second browser
    const browsers = childPids(pid);
    const again = await cli('start');
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ state: 'ready', sessionId });
    expect(readPid(files.pid)).toBe(pid);
    expect(childPids(pid)).toEqual(browsers);

    // the detached watcher really works
    h.edit('src/pages/InvoiceDetail.vue', (s) => s.replace('<h1>Invoice</h1>', '<h1>Invoice (daemon)</h1>'));
    const timeline = h.timeline();
    await until(() => timeline.list({ sessionId }).length > 0, 10_000);
    expect(timeline.list({ sessionId })[0]).toMatchObject({ route: '/manage/invoices/1', status: 'clean' });
    expect(fs.readFileSync(files.log, 'utf8')).toContain('frame f-');

    // status command
    const st = await cli('status');
    expect(JSON.parse(st.stdout)).toMatchObject({ state: 'ready', sessionId, frames: 1 });

    // stop
    const stopped = await cli('stop');
    expect(stopped.code).toBe(0);
    expect(isAlive(pid)).toBe(false);
    expect(fs.existsSync(files.pid)).toBe(false);
    expect(JSON.parse(fs.readFileSync(files.status, 'utf8')).state).toBe('stopped');
    for (const child of browsers) expect(isAlive(child)).toBe(false);

    // stop again is a no-op
    const stoppedAgain = await cli('stop');
    expect(stoppedAgain.code).toBe(0);
    expect(JSON.parse(stoppedAgain.stdout)).toMatchObject({ state: 'stopped' });
  });

  it('a stale pid file does not block start', async () => {
    fs.writeFileSync(files.pid, '999999\n');
    const started = await cli('start');
    expect(started.code).toBe(0);
    const pid = readPid(files.pid)!;
    expect(pid).not.toBe(999999);
    expect((await cli('stop')).code).toBe(0);
    expect(isAlive(pid)).toBe(false);
  });

  it('start reports a one-line reason, not a stack, when the watcher cannot start', async () => {
    // Not a git repository: the watcher fails fast.
    const notGit = path.join(h.dir, '..', 'plain');
    fs.mkdirSync(notGit);
    fs.copyFileSync(h.configPath, path.join(notGit, 'visual-proof.config.json'));
    try {
      const { code, stderr } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', path.join(REPO_ROOT, 'src/cli.ts'), 'start', '--config', path.join(notGit, 'visual-proof.config.json')],
        { cwd: REPO_ROOT, env: h.env },
      ).then(
        (r) => ({ code: 0, stderr: r.stderr }),
        (e: { code?: number; stderr?: string }) => ({ code: e.code ?? 1, stderr: e.stderr ?? '' }),
      );
      expect(code).toBe(1);
      expect(stderr).toMatch(/^visual-proof start: watcher failed to start: /);
      expect(stderr).not.toContain('    at ');
      expect(fs.existsSync(files.pid)).toBe(false);
    } finally {
      fs.rmSync(notGit, { recursive: true, force: true });
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, UsageError } from '../../src/cli.js';
import { tmpDir } from './helpers.js';

describe('parseArgs', () => {
  it.each(['start', 'stop', 'status', 'ready', 'watch', 'finish', 'doctor'] as const)('parses %s', (command) => {
    expect(parseArgs([command])).toMatchObject({ command, hook: false, help: false });
  });

  it('parses --config in both forms', () => {
    expect(parseArgs(['--config', 'a.json', 'watch']).configPath).toBe('a.json');
    expect(parseArgs(['watch', '--config=b.json']).configPath).toBe('b.json');
  });

  it('parses --json for finish and doctor only', () => {
    expect(parseArgs(['finish', '--json'])).toMatchObject({ command: 'finish', json: true });
    expect(parseArgs(['doctor', '--json'])).toMatchObject({ command: 'doctor', json: true });
    expect(parseArgs(['doctor'])).toMatchObject({ json: false });
    expect(() => parseArgs(['status', '--json'])).toThrow(/only valid with the finish and doctor/);
  });

  it('parses status --wait and --timeout, and the ready alias', () => {
    expect(parseArgs(['status', '--wait'])).toMatchObject({ command: 'status', wait: true });
    expect(parseArgs(['status', '--wait']).timeoutSec).toBeUndefined();
    expect(parseArgs(['status', '--wait', '--timeout', '30'])).toMatchObject({ wait: true, timeoutSec: 30 });
    expect(parseArgs(['status', '--wait', '--timeout=1.5'])).toMatchObject({ timeoutSec: 1.5 });
    expect(parseArgs(['ready', '--timeout', '10'])).toMatchObject({ command: 'ready', timeoutSec: 10 });
    expect(parseArgs(['status'])).toMatchObject({ wait: false });
  });

  it.each([
    [['finish', '--wait'], /--wait is only valid with the status command/],
    [['status', '--timeout', '5'], /--timeout is only valid with status --wait or ready/],
    [['status', '--wait', '--timeout'], /--timeout requires a positive number/],
    [['status', '--wait', '--timeout', 'soon'], /--timeout requires a positive number/],
    [['status', '--wait', '--timeout', '0'], /--timeout requires a positive number/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('parses finish --hook', () => {
    expect(parseArgs(['finish', '--hook'])).toMatchObject({ command: 'finish', hook: true });
  });

  it('parses --help with or without a command', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h', 'finish']).help).toBe(true);
  });

  it('returns a null command for no args', () => {
    expect(parseArgs([]).command).toBeNull();
  });

  it.each([
    [['bogus'], /unknown command/],
    [['--wat'], /unknown option/],
    [['start', 'stop'], /unexpected argument/],
    [['--config'], /requires a path/],
    [['watch', '--hook'], /only valid with the finish/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('main', () => {
  let out: string;
  let err: string;

  beforeEach(() => {
    out = '';
    err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true));
  });
  afterEach(() => vi.restoreAllMocks());

  it('prints help and exits 0', async () => {
    expect(await main(['--help'], {})).toBe(0);
    expect(out).toContain('Usage: visual-proof');
  });

  it('documents output, files, exit codes and examples', async () => {
    await main(['--help'], {});
    for (const heading of ['Output:', 'Files', 'Exit codes:', 'Examples:']) expect(out).toContain(heading);
    expect(out).toMatch(/^ {2}3 {3}setup or config error/m);
    expect(out).toContain('visual-proof start');
    expect(out).toContain('visual-proof finish');
    expect(out).toContain('--json');
  });

  it('exits 2 with usage on a bad command', async () => {
    expect(await main(['bogus'], {})).toBe(2);
    expect(err).toContain('unknown command: bogus');
  });

  it('exits 2 when no command is given', async () => {
    expect(await main([], {})).toBe(2);
    expect(err).toContain('Usage:');
  });

  it('start fails with a one-line reason (no stack) when the config is missing', async () => {
    const env = { VISUAL_PROOF_STATUS_DIR: tmpDir() };
    expect(await main(['start', '--config', path.join(tmpDir(), 'nope.json')], env)).toBe(3);
    expect(err).toMatch(/^visual-proof start: config file not found: .*nope\.json\n$/);
  });

  it('watch fails with a one-line reason when the config is invalid', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'c.json'), '{"appUrl": 5}');
    expect(await main(['watch', '--config', path.join(dir, 'c.json')], { VISUAL_PROOF_STATUS_DIR: tmpDir() })).toBe(3);
    expect(err).toContain('visual-proof watch: ');
    expect(err).not.toContain('    at ');
  });

  it('start keeps every invalid config field on its one stderr line', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'c.json'), '{"appUrl": 5, "maxFrames": -1}');
    expect(await main(['start', '--config', path.join(dir, 'c.json')], { VISUAL_PROOF_STATUS_DIR: tmpDir() })).toBe(3);
    expect(err.trimEnd().split('\n')).toHaveLength(1);
    expect(err).toContain('"appUrl"');
    expect(err).toContain('"maxFrames"');
  });

  it('stop reports stopped when nothing is running', async () => {
    expect(await main(['stop'], { VISUAL_PROOF_STATUS_DIR: tmpDir() })).toBe(0);
    expect(JSON.parse(out)).toEqual({ state: 'stopped' });
  });

  it('stop removes a stale pid file', async () => {
    const statusDir = tmpDir();
    fs.writeFileSync(path.join(statusDir, 'daemon.pid'), '999999\n');
    expect(await main(['stop'], { VISUAL_PROOF_STATUS_DIR: statusDir })).toBe(0);
    expect(fs.existsSync(path.join(statusDir, 'daemon.pid'))).toBe(false);
  });

  describe('status', () => {
    const paths = (statusDir: string) => ({
      statusDir,
      proofBlock: path.join(statusDir, 'proof-block.md'),
      log: path.join(statusDir, 'watcher.log'),
      doctor: path.join(statusDir, 'doctor.json'),
    });
    const put = (statusDir: string, status: object): void =>
      fs.writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify(status));

    it('reports stopped, and where the files are, when there is no status file', async () => {
      const statusDir = tmpDir();
      expect(await main(['status'], { VISUAL_PROOF_STATUS_DIR: statusDir })).toBe(0);
      expect(JSON.parse(out)).toEqual({ state: 'stopped', paths: paths(statusDir) });
    });

    it('prints status.json plus paths when the watcher process is alive', async () => {
      const statusDir = tmpDir();
      put(statusDir, { state: 'ready', frames: 3, pid: process.pid });
      expect(await main(['status'], { VISUAL_PROOF_STATUS_DIR: statusDir })).toBe(0);
      expect(JSON.parse(out)).toEqual({ state: 'ready', frames: 3, pid: process.pid, paths: paths(statusDir) });
    });

    it.each(['starting', 'ready', 'capturing'])('a %s status whose watcher is gone is stale: stopped, with the reason', async (state) => {
      const statusDir = tmpDir();
      put(statusDir, { state, frames: 3, pid: 2_000_000_000, pending: true, lastError: null });
      fs.writeFileSync(path.join(statusDir, 'daemon.pid'), '2000000000\n');
      expect(await main(['status'], { VISUAL_PROOF_STATUS_DIR: statusDir })).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        state: 'stopped',
        stale: true,
        pending: false,
        frames: 3,
        lastError: 'watcher exited without stopping',
        paths: paths(statusDir),
      });
    });

    it('a status without a pid and without a pid file cannot be a live watcher', async () => {
      const statusDir = tmpDir();
      put(statusDir, { state: 'ready' });
      await main(['status'], { VISUAL_PROOF_STATUS_DIR: statusDir });
      expect(JSON.parse(out)).toMatchObject({ state: 'stopped', stale: true });
    });

    it('leaves an error or stopped status as it is', async () => {
      const statusDir = tmpDir();
      put(statusDir, { state: 'error', lastError: 'chromium missing', pid: 2_000_000_000 });
      await main(['status'], { VISUAL_PROOF_STATUS_DIR: statusDir });
      const printed = JSON.parse(out);
      expect(printed).toMatchObject({ state: 'error', lastError: 'chromium missing' });
      expect(printed.stale).toBeUndefined();
    });
  });
});

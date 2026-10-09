import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, UsageError } from '../../src/cli.js';
import { tmpDir } from './helpers.js';

describe('parseArgs --probe-decisions', () => {
  it('is a doctor option', () => {
    expect(parseArgs(['doctor', '--probe-decisions'])).toMatchObject({ command: 'doctor', probeDecisions: true });
    expect(parseArgs(['doctor']).probeDecisions).toBe(false);
    expect(() => parseArgs(['finish', '--probe-decisions'])).toThrow('--probe-decisions is only valid with the doctor command');
  });
});

describe('parseArgs', () => {
  it.each(['start', 'stop', 'status', 'ready', 'watch', 'finish', 'doctor'] as const)('parses %s', (command) => {
    expect(parseArgs([command])).toMatchObject({ command, hook: false, help: false });
  });

  it('parses --config in both forms', () => {
    expect(parseArgs(['--config', 'a.json', 'watch']).configPath).toBe('a.json');
    expect(parseArgs(['watch', '--config=b.json']).configPath).toBe('b.json');
  });

  it('parses --json for finish, doctor and params list only', () => {
    expect(parseArgs(['finish', '--json'])).toMatchObject({ command: 'finish', json: true });
    expect(parseArgs(['doctor', '--json'])).toMatchObject({ command: 'doctor', json: true });
    expect(parseArgs(['doctor'])).toMatchObject({ json: false });
    expect(parseArgs(['params', 'list', '--json'])).toMatchObject({ command: 'params', paramsAction: 'list', json: true });
    expect(() => parseArgs(['status', '--json'])).toThrow(/only valid with the finish, doctor and params list/);
    expect(() => parseArgs(['params', 'clear', '--json'])).toThrow(/only valid with the finish, doctor and params list/);
  });

  it('parses --normalize for doctor --json only', () => {
    expect(parseArgs(['doctor', '--json', '--normalize'])).toMatchObject({ command: 'doctor', json: true, normalize: true });
    expect(parseArgs(['doctor', '--json'])).toMatchObject({ normalize: false });
    expect(() => parseArgs(['doctor', '--normalize'])).toThrow(/--normalize is only valid with doctor --json/);
    expect(() => parseArgs(['finish', '--json', '--normalize'])).toThrow(/--normalize is only valid with doctor --json/);
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
    [['status', '--timeout', '5'], /--timeout is only valid with status --wait, ready or params set/],
    [['params', 'list', '--timeout', '5'], /--timeout is only valid with status --wait, ready or params set/],
    [['status', '--wait', '--timeout'], /--timeout requires a positive number/],
    [['status', '--wait', '--timeout', 'soon'], /--timeout requires a positive number/],
    [['status', '--wait', '--timeout', '0'], /--timeout requires a positive number/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  describe('params', () => {
    it('parses set, list and clear with their arguments', () => {
      expect(parseArgs(['params', 'set', '/invoices/:id', 'id=5'])).toMatchObject({
        command: 'params',
        paramsAction: 'set',
        paramsArgs: ['/invoices/:id', 'id=5'],
      });
      expect(parseArgs(['params', 'set', '/a/:x/:y', 'x=1', 'y=2', '--config', 'c.json'])).toMatchObject({ paramsArgs: ['/a/:x/:y', 'x=1', 'y=2'], configPath: 'c.json' });
      expect(parseArgs(['params', 'list'])).toMatchObject({ paramsAction: 'list', paramsArgs: [] });
      expect(parseArgs(['params', 'clear'])).toMatchObject({ paramsAction: 'clear', paramsArgs: [] });
      expect(parseArgs(['params', 'clear', '/invoices/:id'])).toMatchObject({ paramsAction: 'clear', paramsArgs: ['/invoices/:id'] });
    });

    it('keeps values that look odd as arguments', () => {
      expect(parseArgs(['params', 'set', '/u/:id(\\d+)', 'id=-5']).paramsArgs).toEqual(['/u/:id(\\d+)', 'id=-5']);
    });

    it('takes --timeout for set only, and --json for list only', () => {
      expect(parseArgs(['params', 'set', '/a/:id', 'id=1', '--timeout', '5'])).toMatchObject({ timeoutSec: 5 });
      expect(() => parseArgs(['params', 'clear', '--timeout', '5'])).toThrow(/--timeout is only valid/);
      expect(() => parseArgs(['params', 'set', '/a/:id', 'id=1', '--json'])).toThrow(/--json is only valid/);
    });

    it.each([
      [['params'], /params needs an action: set, list or clear/],
      [['params', 'frobnicate'], /unknown params action: frobnicate/],
      [['params', 'set'], /params set needs a route key and at least one param=value/],
      [['params', 'set', '/invoices/:id'], /params set needs a route key and at least one param=value/],
      [['params', 'list', '/x'], /params list takes no arguments/],
      [['params', 'clear', '/x', '/y'], /params clear takes at most one route key/],
      [['finish', 'set'], /unexpected argument: set/],
    ])('rejects %j', (argv, message) => {
      expect(() => parseArgs(argv)).toThrow(UsageError);
      expect(() => parseArgs(argv)).toThrow(message);
    });

    it('does not insist on arguments when asking for help', () => {
      expect(parseArgs(['params', '--help']).help).toBe(true);
      expect(parseArgs(['params', 'set', '--help']).help).toBe(true);
    });
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

  describe('params', () => {
    let repo: string;
    let env: NodeJS.ProcessEnv;
    beforeEach(() => {
      repo = tmpDir();
      env = { VISUAL_PROOF_STATUS_DIR: path.join(tmpDir(), 'status') };
      fs.writeFileSync(path.join(repo, 'router.js'), "export default [{ path: '/invoices/:id', component: Invoice }]\n");
      fs.writeFileSync(path.join(repo, 'c.json'), JSON.stringify({ appUrl: 'http://localhost:1', routeFiles: ['router.js'] }));
    });
    const config = (): string[] => ['--config', path.join(repo, 'c.json')];

    it('is in the help, with its exit codes and the files it writes', async () => {
      await main(['--help'], {});
      expect(out).toContain('params set <routeKey> key=value');
      expect(out).toContain('params list');
      expect(out).toContain('params clear');
      expect(out).toContain('session-params.json');
      expect(out).toContain('exit 2: unknown route key');
    });

    it('exits 2 on a usage error and prints the help', async () => {
      expect(await main(['params'], env)).toBe(2);
      expect(err).toContain('params needs an action');
      err = '';
      expect(await main(['params', 'set', '/invoices/:id'], env)).toBe(2);
      expect(err).toContain('params set needs a route key and at least one param=value');
    });

    it('exits 2 for an unknown route key, 3 for an invalid config, 0 once it works', async () => {
      expect(await main(['params', 'set', '/nope/:id', 'id=1', ...config()], env)).toBe(2);
      expect(err).toContain('closest route keys: /invoices/:id');

      err = '';
      expect(await main(['params', 'set', '/invoices/:id', 'id=1', '--config', path.join(repo, 'missing.json')], env)).toBe(3);
      expect(err).toMatch(/^visual-proof params set: config file not found/);

      err = '';
      expect(await main(['params', 'set', '/invoices/:id', 'id=1', ...config()], env)).toBe(0);
      expect(out).toContain('session params set: /invoices/:id -> /invoices/1');
      expect(err).toContain('no watcher is running');
    });

    it('lists and clears', async () => {
      await main(['params', 'set', '/invoices/:id', 'id=9', ...config()], env);
      out = '';
      expect(await main(['params', 'list', '--json'], env)).toBe(0);
      expect(JSON.parse(out).session).toEqual([expect.objectContaining({ routeKey: '/invoices/:id', path: '/invoices/9' })]);
      out = '';
      expect(await main(['params', 'clear'], env)).toBe(0);
      expect(out).toBe('cleared session params for /invoices/:id\n');
    });
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

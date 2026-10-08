import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, UsageError } from '../../src/cli.js';
import { tmpDir } from './helpers.js';

describe('parseArgs', () => {
  it.each(['start', 'stop', 'status', 'watch', 'finish', 'doctor'] as const)('parses %s', (command) => {
    expect(parseArgs([command])).toMatchObject({ command, hook: false, help: false });
  });

  it('parses --config in both forms', () => {
    expect(parseArgs(['--config', 'a.json', 'watch']).configPath).toBe('a.json');
    expect(parseArgs(['watch', '--config=b.json']).configPath).toBe('b.json');
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
    expect(await main(['start', '--config', path.join(tmpDir(), 'nope.json')], env)).toBe(1);
    expect(err).toMatch(/^visual-proof start: config file not found: .*nope\.json\n$/);
  });

  it('watch fails with a one-line reason when the config is invalid', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'c.json'), '{"appUrl": 5}');
    expect(await main(['watch', '--config', path.join(dir, 'c.json')], { VISUAL_PROOF_STATUS_DIR: tmpDir() })).toBe(1);
    expect(err).toContain('visual-proof watch: ');
    expect(err).not.toContain('    at ');
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

  it('status reports stopped when there is no status file', async () => {
    const env = { VISUAL_PROOF_STATUS_DIR: tmpDir() };
    expect(await main(['status'], env)).toBe(0);
    expect(JSON.parse(out)).toEqual({ state: 'stopped' });
  });

  it('status prints status.json when present', async () => {
    const statusDir = tmpDir();
    fs.writeFileSync(path.join(statusDir, 'status.json'), '{"state":"ready","frames":3}\n');
    expect(await main(['status'], { VISUAL_PROOF_STATUS_DIR: statusDir })).toBe(0);
    expect(JSON.parse(out)).toEqual({ state: 'ready', frames: 3 });
  });
});

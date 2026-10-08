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

  it('prints help and exits 0', () => {
    expect(main(['--help'], {})).toBe(0);
    expect(out).toContain('Usage: visual-proof');
  });

  it('exits 2 with usage on a bad command', () => {
    expect(main(['bogus'], {})).toBe(2);
    expect(err).toContain('unknown command: bogus');
  });

  it('exits 2 when no command is given', () => {
    expect(main([], {})).toBe(2);
    expect(err).toContain('Usage:');
  });

  it.each(['start', 'stop', 'watch', 'finish', 'doctor'])('%s is not implemented yet and exits 2', (command) => {
    expect(main([command], {})).toBe(2);
    expect(err).toContain(`${command}: not implemented`);
  });

  it('status reports stopped when there is no status file', () => {
    const env = { VISUAL_PROOF_STATUS_DIR: tmpDir() };
    expect(main(['status'], env)).toBe(0);
    expect(JSON.parse(out)).toEqual({ state: 'stopped' });
  });

  it('status prints status.json when present', () => {
    const statusDir = tmpDir();
    fs.writeFileSync(path.join(statusDir, 'status.json'), '{"state":"ready","frames":3}\n');
    expect(main(['status'], { VISUAL_PROOF_STATUS_DIR: statusDir })).toBe(0);
    expect(JSON.parse(out)).toEqual({ state: 'ready', frames: 3 });
  });
});

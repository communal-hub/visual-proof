import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ARTIFACT_DIR, DEFAULT_STATUS_DIR, ensureDirs, resolveDirs, statusFiles } from '../../src/paths.js';
import { tmpDir } from './helpers.js';

describe('resolveDirs', () => {
  it('uses the documented defaults', () => {
    expect(resolveDirs({})).toEqual({
      artifactDir: DEFAULT_ARTIFACT_DIR,
      statusDir: DEFAULT_STATUS_DIR,
      scratchDir: path.join(DEFAULT_STATUS_DIR, 'scratch'),
    });
  });

  it('derives scratch from an overridden status dir', () => {
    const dirs = resolveDirs({ VISUAL_PROOF_STATUS_DIR: '/x/status' });
    expect(dirs.scratchDir).toBe('/x/status/scratch');
  });

  it('honours all three env overrides', () => {
    expect(
      resolveDirs({
        VISUAL_PROOF_ARTIFACT_DIR: '/a',
        VISUAL_PROOF_STATUS_DIR: '/s',
        VISUAL_PROOF_SCRATCH_DIR: '/c',
      }),
    ).toEqual({ artifactDir: '/a', statusDir: '/s', scratchDir: '/c' });
  });

  it('treats empty env values as unset', () => {
    expect(resolveDirs({ VISUAL_PROOF_STATUS_DIR: '' }).statusDir).toBe(DEFAULT_STATUS_DIR);
  });
});

describe('ensureDirs / statusFiles', () => {
  it('creates all directories, idempotently', () => {
    const root = tmpDir();
    const dirs = resolveDirs({
      VISUAL_PROOF_ARTIFACT_DIR: path.join(root, 'art'),
      VISUAL_PROOF_STATUS_DIR: path.join(root, 'status'),
    });
    ensureDirs(dirs);
    ensureDirs(dirs);
    for (const dir of Object.values(dirs)) expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('names the daemon files inside the status dir', () => {
    const files = statusFiles({ artifactDir: '/a', statusDir: '/s', scratchDir: '/s/scratch' });
    expect(files.pid).toBe('/s/daemon.pid');
    expect(files.status).toBe('/s/status.json');
    expect(files.log).toBe('/s/watcher.log');
    expect(files.doctor).toBe('/s/doctor.json');
    expect(files.proofBlock).toBe('/s/proof-block.md');
  });
});

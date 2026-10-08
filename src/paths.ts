import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_ARTIFACT_DIR = '/opt/cursor/artifacts';
export const DEFAULT_STATUS_DIR = '/tmp/cursor/visual-proof';

export interface Dirs {
  artifactDir: string;
  statusDir: string;
  scratchDir: string;
}

export function resolveDirs(env: NodeJS.ProcessEnv = process.env): Dirs {
  const statusDir = path.resolve(env.VISUAL_PROOF_STATUS_DIR || DEFAULT_STATUS_DIR);
  return {
    statusDir,
    artifactDir: path.resolve(env.VISUAL_PROOF_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR),
    scratchDir: path.resolve(env.VISUAL_PROOF_SCRATCH_DIR || path.join(statusDir, 'scratch')),
  };
}

/** Files the daemon and `finish` write inside the status dir. */
export function statusFiles(dirs: Dirs) {
  return {
    pid: path.join(dirs.statusDir, 'daemon.pid'),
    status: path.join(dirs.statusDir, 'status.json'),
    log: path.join(dirs.statusDir, 'watcher.log'),
    doctor: path.join(dirs.statusDir, 'doctor.json'),
    proofBlock: path.join(dirs.statusDir, 'proof-block.md'),
  };
}

export function ensureDirs(dirs: Dirs): void {
  for (const dir of [dirs.statusDir, dirs.scratchDir, dirs.artifactDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

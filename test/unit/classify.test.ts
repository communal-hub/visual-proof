import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { classifyCommand, classifyFiles } from '../../src/classify.js';
import { parseConfig, type Config } from '../../src/config.js';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { commitAll, git, initRepo, write } from './helpers.js';

let repo: string;
let config: Config;

const GRAPH: ImportGraph = {
  fileToRoutes: new Map([
    ['src/shared/Picker.vue', ['/a', '/b/:id', '/c']],
    ['src/pages/A.vue', ['/a']],
  ]),
  routes: [],
  unresolved: [],
};
const buildGraph = async () => GRAPH;

beforeEach(() => {
  repo = initRepo();
  write(repo, 'src/pages/A.vue', '<template>A</template>\n');
  write(repo, 'src/shared/Picker.vue', '<template>P</template>\n');
  write(repo, 'src/stories/Picker.stories.vue', 's');
  write(repo, 'lang/en-CA.json', '{}\n');
  write(repo, 'docs/README.md', '# docs\n');
  write(repo, '.visual-proof/sidecars/pick.vp', 'goto /a\nstill open\nstill closed\n');
  commitAll(repo, 'initial');
  config = parseConfig(
    { appUrl: 'http://localhost:1', screenGlobs: ['src/**/*.vue'], ignoreScreenGlobs: ['src/stories/**'], backendGlobs: ['lang/**'], staticRoutes: { 'src/pages/Static.vue': ['/static'] } },
    repo,
    {},
  );
});

describe('classifyFiles', () => {
  it('splits files by the same rules the watcher uses, and lists the screens each one reaches', async () => {
    const result = await classifyFiles(
      config,
      ['src/shared/Picker.vue', 'lang/en-CA.json', 'docs/README.md', 'src/stories/Picker.stories.vue', '.visual-proof/sidecars/pick.vp', 'src/pages/Orphan.vue', 'src/pages/Static.vue'],
      { buildGraph },
    );
    expect(result.needsProof).toBe(true);
    expect(Object.fromEntries(result.files.map((f) => [f.path, f.kinds]))).toEqual({
      '.visual-proof/sidecars/pick.vp': ['sidecar'],
      'docs/README.md': [],
      'lang/en-CA.json': ['backend'],
      'src/pages/Orphan.vue': ['screen'],
      'src/pages/Static.vue': ['screen'],
      'src/shared/Picker.vue': ['screen'],
      'src/stories/Picker.stories.vue': [],
    });
    expect(result.files.find((f) => f.path === 'src/shared/Picker.vue')!.screens).toEqual(['/a', '/b/:id', '/c']);
    expect(result.files.find((f) => f.path === 'src/pages/Orphan.vue')).toMatchObject({ screens: [], unmapped: true });
    expect(result.files.find((f) => f.path === 'src/pages/Static.vue')!.screens).toEqual(['/static']);
    expect(result.screens).toEqual(['/a', '/b/:id', '/c', '/static', 'sidecar pick / closed', 'sidecar pick / open']);
    expect(result.backend).toEqual(['lang/en-CA.json']);
  });

  it('needs no proof for docs, tests and ignored screens', async () => {
    const result = await classifyFiles(config, ['docs/README.md', 'src/stories/Picker.stories.vue'], { buildGraph });
    expect(result).toMatchObject({ needsProof: false, screens: [], backend: [] });
  });

  it('reports a graph failure instead of throwing', async () => {
    const result = await classifyFiles(config, ['src/pages/A.vue'], { buildGraph: async () => Promise.reject(new Error('bad router')) });
    expect(result).toMatchObject({ needsProof: true, error: 'could not build the route graph: bad router' });
  });
});

describe('classifyCommand', () => {
  const run = async (paths: string[], json = false) => {
    let out = '';
    let err = '';
    const code = await classifyCommand({ configPath: path.join(repo, 'visual-proof.config.json'), paths, json, env: { VISUAL_PROOF_STATUS_DIR: path.join(repo, '.status') }, cwd: repo, out: (t) => (out += t), err: (t) => (err += t) });
    return { code, out, err };
  };
  beforeEach(() => {
    write(repo, 'visual-proof.config.json', JSON.stringify({ appUrl: 'http://localhost:1', screenGlobs: ['src/**/*.vue'], backendGlobs: ['lang/**'], staticRoutes: { 'src/pages/A.vue': ['/a'] }, routeFiles: ['src/router/*.js'] }));
    commitAll(repo, 'config');
  });

  it('classifies the given paths and prints a verdict line', async () => {
    const r = await run(['lang/en-CA.json', 'docs/README.md']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^lang\/en-CA\.json\s+backend\s+-> any page/m);
    expect(r.out).toMatch(/^docs\/README\.md\s+none$/m);
    expect(r.out).toMatch(/needs proof: yes \(0 screen, 1 backend, 0 sidecar file\(s\); 0 screen\(s\) reached\)$/m);
  });

  it('without paths, classifies the files changed on the branch, as JSON', async () => {
    git(repo, 'checkout', '-q', '-b', 'work');
    write(repo, 'docs/README.md', '# changed\n');
    commitAll(repo, 'docs only');
    const r = await run([], true);
    expect(JSON.parse(r.out)).toMatchObject({ needsProof: false, range: 'main...HEAD', files: [{ path: 'docs/README.md', kinds: [] }] });
  });

  it('exits 3 on a missing config', async () => {
    let err = '';
    const code = await classifyCommand({ configPath: '/nowhere/visual-proof.config.json', paths: [], env: {}, out: () => {}, err: (t) => (err += t) });
    expect(code).toBe(3);
    expect(err).toContain('config file not found');
  });
});

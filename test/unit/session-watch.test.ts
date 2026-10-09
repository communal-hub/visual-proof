import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setSessionParams, clearSessionParams } from '../../src/resolve/session-params.js';
import { watchSessionParams, type SessionWatchHandle } from '../../src/resolve/session-watch.js';
import { tmpDir } from './helpers.js';

let file: string;
let handle: SessionWatchHandle | null;
let calls: number;

beforeEach(() => {
  file = path.join(tmpDir('vp-sessionwatch-'), 'session-params.json');
  handle = null;
  calls = 0;
});
afterEach(async () => {
  await handle?.stop();
});

const until = async (predicate: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const entry = { path: '/a/1', params: { id: '1' }, at: 'now' };

describe('watchSessionParams', () => {
  it('reports a file created after the watch started, then each rewrite, then its removal', async () => {
    handle = await watchSessionParams(file, () => calls++);
    setSessionParams(file, '/a/:id', entry);
    await until(() => calls >= 1);
    const afterCreate = calls;
    setSessionParams(file, '/b/:id', entry);
    await until(() => calls > afterCreate);
    const afterRewrite = calls;
    fs.rmSync(file);
    await until(() => calls > afterRewrite);
  });

  it('reports a clear (a rewrite with fewer entries)', async () => {
    setSessionParams(file, '/a/:id', entry);
    handle = await watchSessionParams(file, () => calls++);
    clearSessionParams(file);
    await until(() => calls >= 1);
  });

  it('ignores other files in the same directory', async () => {
    handle = await watchSessionParams(file, () => calls++);
    fs.writeFileSync(path.join(path.dirname(file), 'status.json'), '{}');
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
  });

  it('stops reporting after stop()', async () => {
    handle = await watchSessionParams(file, () => calls++);
    await handle.stop();
    setSessionParams(file, '/a/:id', entry);
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
  });
});

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { consoleErrorFilter } from '../../src/console.js';
import { tmpDir } from './helpers.js';

const CSP = "Refused to apply inline style because it violates the following Content Security Policy directive: style-src 'self'.";
const APP = 'https://app.test';

describe('console ignore config', () => {
  it('defaults to ignoring only third-party inline-style CSP errors with a known source', () => {
    const config = parseConfig({ appUrl: APP }, '/repo', {});
    const ignored = consoleErrorFilter(config.console, APP);
    expect(ignored(CSP, 'https://vendor.test/embed.js')).toBe(true);
    expect(ignored(CSP, `${APP}/app.js`)).toBe(false);
    expect(ignored(CSP, '')).toBe(false);
    expect(ignored('TypeError: cannot read property', 'https://vendor.test/embed.js')).toBe(false);
    expect(ignored('Refused to execute inline script due to Content Security Policy', 'https://vendor.test/embed.js')).toBe(false);
    expect(consoleErrorFilter({ ignore: [], ignoreThirdPartyCsp: false }, APP)(CSP, 'https://vendor.test/embed.js')).toBe(false);
  });

  it('matches message regexes with optional source URL regexes', () => {
    const config = parseConfig({ appUrl: APP, console: { ignore: [{ message: '^known noise$', sourceUrl: '^https://vendor\\.test/' }, { message: '^benign warning' }] } }, '/repo', {});
    const ignored = consoleErrorFilter(config.console, APP);
    expect(ignored('known noise', 'https://vendor.test/embed.js')).toBe(true);
    expect(ignored('known noise', `${APP}/app.js`)).toBe(false);
    expect(ignored('benign warning: ignored', '')).toBe(true);
    expect(() => parseConfig({ appUrl: APP, console: { ignore: [{ message: '[', sourceUrl: '(' }] } }, '/repo', {})).toThrow(/console.ignore\[0\].message.*valid regex/);
    expect(() => parseConfig({ appUrl: APP, console: { ignore: [{ sourceUrl: 'x' }] } }, '/repo', {})).toThrow(/message.*required/);
  });

  it('applies in watcher-style captures AND sidecar replays in an independent process, without NODE_OPTIONS', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<div id="app"><main>Scanned members</main></div><script>
        console.error('known noise');
        (0, eval)(${JSON.stringify(`console.error(${JSON.stringify(CSP)});\n//# sourceURL=https://vendor.test/embed.js`)});
        console.error(${JSON.stringify(CSP)});
        console.error('real app error');
        setTimeout(() => { throw new Error('real page exception'); }, 0);
      </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const appUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = tmpDir('vp-console-');
    const configFile = path.join(dir, 'visual-proof.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ appUrl, replay: { enabled: false, motion: false }, console: { ignore: [{ message: '^known noise$', sourceUrl: '^http://127\\.0\\.0\\.1:' }] }, settle: { networkIdleMs: 20, maxWaitMs: 300 } }));
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const child = `
      import { Browser } from ${JSON.stringify(`${root}/src/browser.ts`)};
      import { loadConfig } from ${JSON.stringify(`${root}/src/config.ts`)};
      import { parseSidecar } from ${JSON.stringify(`${root}/src/sidecar.ts`)};
      const config = loadConfig({ configPath: process.argv[1], env: {} });
      const browser = await Browser.launch(config);
      try {
        const capture = await browser.capture(config.appUrl);
        const sidecar = parseSidecar('goto /\\nstill members\\n', 'members.vp');
        const replay = await browser.runScenario({ file: 'members.vp', name: 'members', steps: sidecar.steps, gotos: new Map([[1, { url: config.appUrl, path: '/' }]]) });
        console.log(JSON.stringify({ capture: capture.signals, replay: replay.stills[0].signals, preload: process.env.NODE_OPTIONS ?? null }));
      } finally { await browser.close(); }
    `;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child, configFile], { cwd: root, env, timeout: 20_000 });
      const result = JSON.parse(stdout);
      expect(result.preload).toBeNull();
      for (const signals of [result.capture, result.replay]) {
        expect(signals.consoleErrors).toEqual([CSP, 'real app error']);
        expect(signals.pageErrors).toEqual(['real page exception']);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import {
  findSidecarFiles,
  formatSidecarError,
  gotoRouteKeys,
  isSidecarRoute,
  parseSidecar,
  parseSidecarRoute,
  roleEmail,
  scenarioRouteKeys,
  sidecarName,
  sidecarRoute,
  validateSidecar,
} from '../../src/sidecar.js';
import { tmpDir, write } from './helpers.js';

const parse = (text: string) => parseSidecar(text, '.visual-proof/sidecars/refund.vp');

describe('parseSidecar', () => {
  it('parses every verb with its line number and source text', () => {
    const s = parse(
      [
        '# refund flow',
        '',
        'goto /manage/invoices/:id',
        'click [data-test=invoice-refund]',
        'fill [data-test=amount] 12.50',
        'press Enter',
        'wait [data-test=refund-modal]',
        'wait 500',
        'still refund-modal',
        'login finance',
      ].join('\n'),
    );
    expect(s.errors).toEqual([]);
    expect(s.name).toBe('refund');
    expect(s.stills).toEqual(['refund-modal']);
    expect(s.steps).toEqual([
      { verb: 'goto', line: 3, text: 'goto /manage/invoices/:id', target: '/manage/invoices/:id' },
      { verb: 'click', line: 4, text: 'click [data-test=invoice-refund]', selector: '[data-test=invoice-refund]' },
      { verb: 'fill', line: 5, text: 'fill [data-test=amount] 12.50', selector: '[data-test=amount]', value: '12.50' },
      { verb: 'press', line: 6, text: 'press Enter', key: 'Enter' },
      { verb: 'wait', line: 7, text: 'wait [data-test=refund-modal]', selector: '[data-test=refund-modal]' },
      { verb: 'wait', line: 8, text: 'wait 500', ms: 500 },
      { verb: 'still', line: 9, text: 'still refund-modal', name: 'refund-modal' },
      { verb: 'login', line: 10, text: 'login finance', role: 'finance' },
    ]);
  });

  it('skips blank lines and # comments, handles CRLF and a BOM, and keeps # inside a line (an id selector)', () => {
    const s = parse('﻿  # indented comment\r\n\r\ngoto /\r\n  click #submit  \r\nstill s\r\n');
    expect(s.errors).toEqual([]);
    expect(s.steps.map((x) => [x.line, x.text])).toEqual([[3, 'goto /'], [4, 'click #submit'], [5, 'still s']]);
    expect(s.steps[1]).toMatchObject({ selector: '#submit' });
  });

  it('click and wait take the rest of the line as the selector, spaces and all', () => {
    const s = parse('goto /\nclick button:has-text("Refund now")\nwait .a .b > span\nstill s');
    expect(s.errors).toEqual([]);
    expect(s.steps[1]).toMatchObject({ selector: 'button:has-text("Refund now")' });
    expect(s.steps[2]).toMatchObject({ selector: '.a .b > span' });
  });

  describe('fill', () => {
    const fill = (rest: string) => parse(`goto /\nfill ${rest}\nstill s`);

    it('takes the first word as the selector and the rest of the line as text', () => {
      expect(fill('[name=q] hello big world').steps[1]).toMatchObject({ selector: '[name=q]', value: 'hello big world' });
    });

    it('takes quoted text, with escapes, and keeps its inner spaces and #', () => {
      expect(fill('[name=q] "  a # b  "').steps[1]).toMatchObject({ value: '  a # b  ' });
      expect(fill(`[name=q] 'it''s'`).errors[0]!.message).toContain('unexpected text after the closing quote');
      expect(fill('[name=q] "say \\"hi\\"\\nbye\\\\"').steps[1]).toMatchObject({ value: 'say "hi"\nbye\\' });
      expect(fill("[name=q] 'single quoted'").steps[1]).toMatchObject({ value: 'single quoted' });
    });

    it('allows empty text only when written as ""', () => {
      expect(fill('[name=q] ""').steps[1]).toMatchObject({ value: '' });
      expect(fill('[name=q]').errors).toEqual([{ line: 2, message: expect.stringContaining('fill needs a selector and text') }]);
    });

    it('takes a quoted selector when it contains spaces', () => {
      expect(fill('"input[name=\'first name\']" Ada').steps[1]).toMatchObject({ selector: "input[name='first name']", value: 'Ada' });
    });

    it('reports an unterminated quote', () => {
      expect(fill('[name=q] "oops').errors).toEqual([{ line: 2, message: 'missing closing " quote' }]);
      expect(fill('"oops [name=q] x').errors[0]!.message).toBe('missing closing " quote');
    });

    it('rejects text that continues after a closing quote', () => {
      expect(fill('[name=q] "a" b').errors[0]!.message).toContain('unexpected text after the closing quote: "b"');
    });
  });

  describe('errors name the line and the problem', () => {
    const errors = (text: string) => parse(`${text}\nstill ok`).errors;

    it('unknown verb', () => {
      expect(errors('goto /\nclik [x]')).toEqual([
        { line: 2, message: 'unknown verb "clik" (the verbs are goto, click, fill, press, wait, still, login)' },
      ]);
      expect(errors('Click [x]')[0]!.message).toContain('unknown verb "Click"');
    });

    it('missing arguments', () => {
      expect(errors('goto')[0]).toMatchObject({ line: 1, message: expect.stringContaining('goto needs a route key or path') });
      expect(errors('click')[0]!.message).toContain('click needs a selector');
      expect(errors('press')[0]!.message).toContain('press needs a key');
      expect(errors('wait')[0]!.message).toContain('wait needs a selector or a number');
      expect(errors('still')[0]!.message).toContain('still needs a name');
      expect(errors('login')[0]!.message).toContain('login needs a role');
    });

    it('goto must be a path starting with /', () => {
      expect(errors('goto invoices')[0]!.message).toContain('must be a route key or path starting with "/"');
      expect(errors('goto http://x.test/a')[0]!.message).toContain('starting with "/"');
      expect(errors('goto //evil.test/x')[0]!.message).toContain('starting with "/"');
      expect(errors('goto /a /b')[0]!.message).toContain('goto takes one route key or path');
    });

    it('press takes one key; wait ms is bounded', () => {
      expect(errors('press Control A')[0]!.message).toContain('press takes one key');
      expect(errors('wait 0')[0]!.message).toContain('between 1 and 30000');
      expect(errors('wait 99999')[0]!.message).toContain('between 1 and 30000');
      expect(parse('wait 30000ms\nstill a').errors).toEqual([]);
    });

    it('still names are plain and unique', () => {
      expect(errors('still has space')[0]!.message).toContain('still name must be letters, digits');
      expect(errors('still -x')[0]!.message).toContain('still name must be');
      expect(errors('still ok')[0]).toEqual({ line: 2, message: 'duplicate still name "ok" (first used on line 1)' });
    });

    it('collects every error rather than stopping at the first', () => {
      expect(errors('nope\nclick\ngoto x').map((e) => e.line)).toEqual([1, 2, 3]);
    });
  });

  it('a scenario needs at least one still and one step', () => {
    expect(parse('goto /\nclick x').errors).toEqual([{ line: 0, message: expect.stringContaining('no still step') }]);
    expect(parse('# nothing\n\n').errors).toEqual([{ line: 0, message: expect.stringContaining('no steps') }]);
  });

  it('formats errors as file:line: message', () => {
    expect(formatSidecarError('a.vp', { line: 3, message: 'boom' })).toBe('a.vp:3: boom');
    expect(formatSidecarError('a.vp', { line: 0, message: 'boom' })).toBe('a.vp: boom');
  });
});

describe('routes and names', () => {
  it('names a scenario by its filename', () => {
    expect(sidecarName('.visual-proof/sidecars/refund.vp')).toBe('refund');
    expect(sidecarName('a/b/two.part.vp')).toBe('two.part');
  });

  it('builds and parses sidecar routes', () => {
    const route = sidecarRoute('.visual-proof/sidecars/refund.vp', 'refund-modal');
    expect(route).toBe('sidecar:.visual-proof/sidecars/refund.vp#refund-modal');
    expect(isSidecarRoute(route)).toBe(true);
    expect(isSidecarRoute('/invoices')).toBe(false);
    expect(parseSidecarRoute(route)).toEqual({ file: '.visual-proof/sidecars/refund.vp', still: 'refund-modal' });
    expect(parseSidecarRoute('/invoices/1')).toBeNull();
  });
});

describe('validateSidecar and roleEmail', () => {
  const config = parseConfig(
    { appUrl: 'http://a.test', login: { type: 'http-hook', url: '/l', email: 'admin@x.test' }, roles: { finance: 'fin@x.test' } },
    '/repo',
    {},
  );

  it('accepts default and configured roles, flags unknown ones with the known list', () => {
    const s = parse('login default\nlogin finance\nlogin ghost\nstill s');
    expect(s.errors).toEqual([]);
    expect(validateSidecar(s, config)).toEqual([
      { line: 3, message: 'unknown role "ghost" (known: default, finance; add it to "roles")' },
    ]);
  });

  it('login needs a login hook', () => {
    const none = parseConfig({ appUrl: 'http://a.test' }, '/repo', {});
    expect(validateSidecar(parse('login default\nstill s'), none)).toEqual([
      { line: 1, message: 'login needs a login hook: set login.type to "http-hook"' },
    ]);
  });

  it('maps roles to emails; default is the login email', () => {
    expect(roleEmail('default', config)).toBe('admin@x.test');
    expect(roleEmail('finance', config)).toBe('fin@x.test');
    expect(roleEmail('ghost', config)).toBeNull();
  });
});

describe('route keys of a scenario', () => {
  const known = ['/', '/manage/invoices', '/manage/invoices/:id', '/manage/invoices/new', '/settings/profile'];

  it('a route key stands for itself; a concrete path for the pattern that matches it', () => {
    expect(gotoRouteKeys('/manage/invoices/:id', known)).toEqual(['/manage/invoices/:id']);
    expect(gotoRouteKeys('/manage/invoices/42', known)).toEqual(['/manage/invoices/:id']);
    expect(gotoRouteKeys('/manage/invoices/42?tab=2#x', known)).toEqual(['/manage/invoices/:id']);
    expect(gotoRouteKeys('/settings/profile/', known)).toEqual(['/settings/profile']);
  });

  it('a static route beats a parametrised one that also matches', () => {
    expect(gotoRouteKeys('/manage/invoices/new', known)).toEqual(['/manage/invoices/new']);
  });

  it('an unknown path stands for its pathname', () => {
    expect(gotoRouteKeys('/nowhere?x=1', known)).toEqual(['/nowhere']);
  });

  it('collects the keys of every goto', () => {
    const s = parse('goto /\ngoto /manage/invoices/7\nclick x\nstill s');
    expect(scenarioRouteKeys(s, known).sort()).toEqual(['/', '/manage/invoices/:id']);
  });
});

describe('findSidecarFiles', () => {
  it('finds files by glob, relative to the repo, sorted, skipping node_modules', () => {
    const repo = tmpDir('vp-sidecar-');
    write(repo, '.visual-proof/sidecars/b.vp', 'x');
    write(repo, '.visual-proof/sidecars/a.vp', 'x');
    write(repo, '.visual-proof/sidecars/notes.txt', 'x');
    write(repo, '.visual-proof/sidecars/deep/c.vp', 'x');
    write(repo, 'node_modules/p/.visual-proof/sidecars/z.vp', 'x');
    expect(findSidecarFiles(repo, ['.visual-proof/sidecars/*.vp'])).toEqual(['.visual-proof/sidecars/a.vp', '.visual-proof/sidecars/b.vp']);
    expect(findSidecarFiles(repo, ['.visual-proof/sidecars/**/*.vp'])).toEqual([
      '.visual-proof/sidecars/a.vp',
      '.visual-proof/sidecars/b.vp',
      '.visual-proof/sidecars/deep/c.vp',
    ]);
    expect(findSidecarFiles(repo, ['scenarios/*.vp'])).toEqual([]);
    expect(findSidecarFiles(repo, [])).toEqual([]);
    expect(path.isAbsolute(findSidecarFiles(repo, ['**/*.vp'])[0]!)).toBe(false);
  });
});

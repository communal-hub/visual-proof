import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildImportGraph, type ImportGraph } from '../../src/resolve/import-graph.js';
import { tmpDir, write } from './helpers.js';

let root: string;

beforeEach(() => {
  root = tmpDir('vp-graph-');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function build(overrides: Partial<Parameters<typeof buildImportGraph>[0]> = {}): Promise<ImportGraph> {
  return buildImportGraph({
    repoDir: root,
    routeFiles: ['src/router/**/*.{js,ts}'],
    srcRoots: ['src'],
    aliases: { '@': 'src' },
    ...overrides,
  });
}

function routesOf(graph: ImportGraph, file: string): string[] {
  return graph.fileToRoutes.get(file) ?? [];
}

describe('buildImportGraph: realistic project', () => {
  beforeEach(() => {
    write(
      root,
      'src/router/index.js',
      `
import { createRouter } from 'vue-router'
import Home from '@/pages/Home.vue'
import Invoice from '../pages/Invoice.vue'
import AdminLayout from '@/layouts/AdminLayout.vue'
import Users from '@/pages/admin/Users.vue'
import Settings from '@/pages/admin/Settings.vue'

const Lazy = () => import('@/pages/Lazy.vue')

export default [
  { path: '/', component: Home },
  { path: '/invoices/:id', name: 'invoice', component: Invoice },
  // { path: '/commented-out', component: Home },
  { path: '/reports', component: () => import('@/pages/Reports.vue') },
  { path: '/lazy', component: Lazy },
  {
    path: '/admin',
    component: AdminLayout,
    children: [
      { path: 'users', component: Users },
      { path: 'settings/', component: Settings, meta: { title: 'a, b: {c}' } },
    ],
  },
  { path: '/old', redirect: '/' },
]
`,
    );
    write(root, 'src/pages/Home.vue', `<template><Shared/></template>\n<script setup>\nimport Shared from '@/components/Shared.vue'\n</script>\n<style>.a{}</style>`);
    write(
      root,
      'src/pages/Invoice.vue',
      `<template><Shared/></template>\n<script>\nimport Shared from '../components/Shared.vue'\nimport { useInvoice } from '@/composables/useInvoice'\nexport default { components: { Shared } }\n</script>`,
    );
    write(root, 'src/composables/useInvoice.ts', `import type { Foo } from '@/types'\nimport { get } from './api.js'\nexport const useInvoice = (id: number): Promise<string> => get(id)`);
    write(root, 'src/composables/api.js', `export const get = () => 1`);
    write(root, 'src/types.ts', `export interface Foo {}`);
    write(root, 'src/components/Shared.vue', `<script setup>\nimport Deep from './Deep.vue'\nimport '@/styles/shared.css'\n</script>`);
    write(root, 'src/components/Deep.vue', `<script setup lang="ts">\nimport Shared from './Shared.vue'\n</script>`);
    write(root, 'src/styles/shared.css', `.x{}`);
    write(root, 'src/pages/Reports.vue', `<script setup lang="ts">\nimport type { Foo } from '@/types'\nconst Chart = defineAsyncComponent(() => import('../components/Chart.vue'))\n</script>`);
    write(root, 'src/components/Chart.vue', `<template><div/></template>`);
    write(root, 'src/pages/Lazy.vue', `<template><div/></template>`);
    write(root, 'src/layouts/AdminLayout.vue', `<script setup>\nimport Nav from '@/components/Nav.vue'\n</script>`);
    write(root, 'src/components/Nav.vue', `<template><nav/></template>`);
    write(root, 'src/pages/admin/Users.vue', `<template><div/></template>`);
    write(root, 'src/pages/admin/Settings.vue', `<script>\nimport Gone from './Gone.vue'\n</script>`);
    write(root, 'src/components/Orphan.vue', `<template><div/></template>`);
  });

  it('extracts routes with nested children joined to their parent', async () => {
    const graph = await build();
    expect(graph.routes.map((r) => r.path).sort()).toEqual([
      '/',
      '/admin/settings',
      '/admin/users',
      '/invoices/:id',
      '/lazy',
      '/reports',
    ]);
    const users = graph.routes.find((r) => r.path === '/admin/users')!;
    expect(users).toMatchObject({
      routeFile: 'src/router/index.js',
      component: 'src/pages/admin/Users.vue',
      layouts: ['src/layouts/AdminLayout.vue'],
      dynamic: false,
    });
  });

  it('ignores commented-out routes and redirect-only routes', async () => {
    const graph = await build();
    const paths = graph.routes.map((r) => r.path);
    expect(paths).not.toContain('/commented-out');
    expect(paths).not.toContain('/old');
  });

  it('marks dynamic imports, both inline and via a lazy const', async () => {
    const graph = await build();
    expect(graph.routes.find((r) => r.path === '/reports')).toMatchObject({
      component: 'src/pages/Reports.vue',
      dynamic: true,
    });
    expect(graph.routes.find((r) => r.path === '/lazy')).toMatchObject({
      component: 'src/pages/Lazy.vue',
      dynamic: true,
    });
    expect(graph.routes.find((r) => r.path === '/')!.dynamic).toBe(false);
  });

  it('maps a shared component to every route that renders it, transitively and across cycles', async () => {
    const graph = await build();
    expect(routesOf(graph, 'src/components/Shared.vue')).toEqual(['/', '/invoices/:id']);
    expect(routesOf(graph, 'src/components/Deep.vue')).toEqual(['/', '/invoices/:id']);
    expect(routesOf(graph, 'src/styles/shared.css')).toEqual(['/', '/invoices/:id']);
  });

  it('follows aliased and extensionless .ts imports from .vue script blocks', async () => {
    const graph = await build();
    expect(routesOf(graph, 'src/composables/useInvoice.ts')).toEqual(['/invoices/:id']);
    expect(routesOf(graph, 'src/composables/api.js')).toEqual(['/invoices/:id']);
  });

  it('skips type-only imports', async () => {
    const graph = await build();
    expect(graph.fileToRoutes.has('src/types.ts')).toBe(false);
  });

  it('follows dynamic imports inside components', async () => {
    const graph = await build();
    expect(routesOf(graph, 'src/components/Chart.vue')).toEqual(['/reports']);
  });

  it('applies layout components to every child route', async () => {
    const graph = await build();
    expect(routesOf(graph, 'src/layouts/AdminLayout.vue')).toEqual(['/admin/settings', '/admin/users']);
    expect(routesOf(graph, 'src/components/Nav.vue')).toEqual(['/admin/settings', '/admin/users']);
  });

  it('does not map files no page imports, nor the route file itself', async () => {
    const graph = await build();
    expect(graph.fileToRoutes.has('src/components/Orphan.vue')).toBe(false);
    expect(graph.fileToRoutes.has('src/router/index.js')).toBe(false);
  });

  it('records unresolvable imports without throwing', async () => {
    const graph = await build();
    expect(graph.unresolved).toEqual(["src/pages/admin/Settings.vue: cannot resolve import './Gone.vue'"]);
  });

  it('is deterministic: sorted keys and values', async () => {
    const graph = await build();
    const keys = [...graph.fileToRoutes.keys()];
    expect(keys).toEqual([...keys].sort());
  });
});

describe('buildImportGraph: other shapes', () => {
  it('parses TypeScript route files with annotations and chunk-name comments', async () => {
    write(
      root,
      'src/router/index.ts',
      `
import type { RouteRecordRaw } from 'vue-router'
import Home from '@/Home.vue'
const routes: RouteRecordRaw[] = [
  { path: '/', component: Home as unknown as object },
  { path: "/x", component: () => import(/* webpackChunkName: "x" */ '@/X.vue') },
]
export default routes
`,
    );
    write(root, 'src/Home.vue', '<template/>');
    write(root, 'src/X.vue', '<template/>');
    const graph = await build();
    // `Home as unknown as object` is not a plain identifier, so it is reported rather than guessed.
    expect(graph.routes.find((r) => r.path === '/x')).toMatchObject({ component: 'src/X.vue', dynamic: true });
    expect(graph.unresolved.some((u) => u.includes('cannot resolve component'))).toBe(true);
  });

  it('reads several route files and joins roots from their own declarations', async () => {
    write(root, 'src/router/a.js', `import A from '@/A.vue'\nexport default [{ path: '/a', component: A }]`);
    write(root, 'src/router/b/b.js', `import B from '@/B.vue'\nexport default [{ path: '/b', component: B }]`);
    write(root, 'src/A.vue', `<script setup>\nimport S from '@/S.vue'\n</script>`);
    write(root, 'src/B.vue', `<script setup>\nimport S from '@/S.vue'\n</script>`);
    write(root, 'src/S.vue', '<template/>');
    const graph = await build();
    expect(routesOf(graph, 'src/S.vue')).toEqual(['/a', '/b']);
    expect(graph.routes.map((r) => r.routeFile).sort()).toEqual(['src/router/a.js', 'src/router/b/b.js']);
  });

  it('resolves bare imports under srcRoots and index files', async () => {
    write(root, 'src/router/index.js', `import Page from 'pages/Page.vue'\nexport default [{ path: '/p', component: Page }]`);
    write(root, 'src/pages/Page.vue', `<script setup>\nimport Widget from '@/widgets'\nimport { ref } from 'vue'\n</script>`);
    write(root, 'src/widgets/index.js', `export default {}`);
    const graph = await build();
    expect(routesOf(graph, 'src/widgets/index.js')).toEqual(['/p']);
    expect(graph.unresolved).toEqual([]);
  });

  it('honours custom aliases, including absolute alias targets', async () => {
    write(root, 'src/router/index.js', `import P from '~/P.vue'\nimport Q from '#q/Q.vue'\nexport default [{ path: '/p', component: P }, { path: '/q', component: Q }]`);
    write(root, 'app/P.vue', '<template/>');
    write(root, 'lib/Q.vue', '<template/>');
    const graph = await build({ aliases: { '~': 'app', '#q': `${root}/lib` } });
    expect(routesOf(graph, 'app/P.vue')).toEqual(['/p']);
    expect(routesOf(graph, 'lib/Q.vue')).toEqual(['/q']);
  });

  it('treats a layout with an empty-path child as a leaf route at the parent path', async () => {
    write(
      root,
      'src/router/index.js',
      `import L from '@/L.vue'\nimport I from '@/I.vue'\nexport default [{ path: '/app', component: L, children: [{ path: '', component: I }] }]`,
    );
    write(root, 'src/L.vue', '<template/>');
    write(root, 'src/I.vue', '<template/>');
    const graph = await build();
    expect(graph.routes.map((r) => r.path)).toEqual(['/app']);
    expect(routesOf(graph, 'src/L.vue')).toEqual(['/app']);
  });

  it('supports <script src> and notes computed dynamic imports', async () => {
    write(root, 'src/router/index.js', `import P from '@/P.vue'\nexport default [{ path: '/p', component: P }]`);
    write(root, 'src/P.vue', `<script src="./p-logic.js"></script>`);
    write(root, 'src/p-logic.js', 'const n = "x"; export const load = () => import(`./dyn/${n}.js`)');
    const graph = await build();
    expect(routesOf(graph, 'src/p-logic.js')).toEqual(['/p']);
    expect(graph.unresolved).toEqual(['src/p-logic.js: dynamic import glob ./dyn/*.js']);
  });

  it('reports unresolved route components and non-literal paths', async () => {
    write(
      root,
      'src/router/index.js',
      `const base = '/x'\nexport default [{ path: base + '/y', component: Missing }, { path: '/z', component: { template: '<p/>' } }]`,
    );
    const graph = await build();
    // The non-literal path is dropped; the inline component is kept as a route with no source file.
    expect(graph.routes).toEqual([
      { path: '/z', routeFile: 'src/router/index.js', component: null, layouts: [], dynamic: false },
    ]);
    expect(graph.unresolved).toEqual(
      expect.arrayContaining([
        expect.stringContaining('non-literal route path'),
        expect.stringContaining('cannot resolve component'),
      ]),
    );
  });

  it('reads Vue Router syntax in a path: custom regex (escaped backslashes), optional, repeatable, nested', async () => {
    write(
      root,
      'src/router/index.js',
      [
        "import A from '@/A.vue'",
        'export default [',
        "  { path: '/users/:id(\\\\d+)', component: A },",
        "  { path: '/docs/:slug?', component: A },",
        "  { path: '/files/:path+', component: A },",
        "  { path: '/clubs/:clubId', component: A, children: [{ path: 'teams/:teamId(\\\\d+)', component: A }] },",
        "  { path: '/:pathMatch(.*)*', component: A },",
        ']',
      ].join('\n'),
    );
    write(root, 'src/A.vue', '<template/>');
    const graph = await build();
    expect(graph.routes.map((r) => r.path).sort()).toEqual(['/:pathMatch(.*)*', '/clubs/:clubId/teams/:teamId(\\d+)', '/docs/:slug?', '/files/:path+', '/users/:id(\\d+)'].sort());
    expect(graph.unresolved).toEqual([]);
  });

  it('still drops a path with an escape it cannot decode, as non-literal', async () => {
    write(root, 'src/router/index.js', "import A from '@/A.vue'\nexport default [{ path: '/x/\\n', component: A }]");
    write(root, 'src/A.vue', '<template/>');
    const graph = await build();
    expect(graph.routes).toEqual([]);
    expect(graph.unresolved).toEqual([expect.stringContaining('non-literal route path')]);
  });

  it('returns an empty graph when no route files match', async () => {
    write(root, 'src/App.vue', '<template/>');
    const graph = await build();
    expect(graph.routes).toEqual([]);
    expect(graph.fileToRoutes.size).toBe(0);
    expect(graph.unresolved).toEqual([]);
  });

  it('records a parse error and carries on', async () => {
    write(root, 'src/router/index.js', `import P from '@/P.vue'\nimport Q from '@/Q.vue'\nexport default [{ path: '/p', component: P }, { path: '/q', component: Q }]`);
    write(root, 'src/P.vue', `<script>\nimport {{{ from './x'\n</script>`);
    write(root, 'src/Q.vue', '<template/>');
    const graph = await build();
    expect(graph.routes.map((r) => r.path)).toEqual(['/p', '/q']);
    expect(graph.unresolved.some((u) => u.startsWith('src/P.vue: parse error'))).toBe(true);
  });

  it('does not walk node_modules when route globs start at the repo root', async () => {
    write(root, 'node_modules/pkg/routes.js', `export default [{ path: '/bad', component: X }]`);
    write(root, 'routes.js', `import H from './H.vue'\nexport default [{ path: '/', component: H }]`);
    write(root, 'H.vue', '<template/>');
    const graph = await build({ routeFiles: ['**/routes.js'] });
    expect(graph.routes.map((r) => r.path)).toEqual(['/']);
  });
});

describe('buildImportGraph: TypeScript ESM specifiers', () => {
  it('resolves a missing .js/.mjs specifier to its .ts/.tsx/.mts source', async () => {
    write(
      root,
      'src/router/index.js',
      `import P from '@/P.vue'\nexport default [{ path: '/p', component: P }]`,
    );
    write(
      root,
      'src/P.vue',
      `<script setup lang="ts">
import { Form } from '@/models/Form.js'
import Widget from './Widget.js'
import { m } from './m.mjs'
import real from './real.js'
</script>`,
    );
    write(root, 'src/models/Form.ts', 'export class Form {}');
    write(root, 'src/Widget.tsx', 'export default 1');
    write(root, 'src/m.mts', 'export const m = 1');
    write(root, 'src/real.js', 'export default 1');
    write(root, 'src/real.ts', 'export default 2');
    const graph = await build();
    expect(graph.unresolved).toEqual([]);
    expect(routesOf(graph, 'src/models/Form.ts')).toEqual(['/p']);
    expect(routesOf(graph, 'src/Widget.tsx')).toEqual(['/p']);
    expect(routesOf(graph, 'src/m.mts')).toEqual(['/p']);
    // An existing .js file wins over a same-named .ts file.
    expect(routesOf(graph, 'src/real.js')).toEqual(['/p']);
    expect(graph.fileToRoutes.has('src/real.ts')).toBe(false);
  });

  it('still reports a .js specifier with no TypeScript counterpart', async () => {
    write(root, 'src/router/index.js', `import P from '@/P.vue'\nexport default [{ path: '/p', component: P }]`);
    write(root, 'src/P.vue', `<script setup>\nimport x from './nope.js'\n</script>`);
    const graph = await build();
    expect(graph.unresolved).toEqual(["src/P.vue: cannot resolve import './nope.js'"]);
  });
});

describe('buildImportGraph: SFC script extraction', () => {
  async function importsOf(sfc: string): Promise<string[]> {
    write(root, 'src/router/index.js', `import P from '@/P.vue'\nexport default [{ path: '/p', component: P }]`);
    write(root, 'src/P.vue', sfc);
    write(root, 'src/dep-a.ts', 'export const a = 1');
    write(root, 'src/dep-b.ts', 'export const b = 1');
    write(root, 'src/dep-c.ts', 'export const c = 1');
    const graph = await build();
    expect(graph.unresolved).toEqual([]);
    return [...graph.fileToRoutes.keys()].filter((f) => f.startsWith('src/dep-'));
  }

  it('handles <script setup lang="ts" generic="..."> with ">" inside the attribute', async () => {
    const deps = await importsOf(`<template>
  <div>{{ item }}</div>
</template>

<script setup lang="ts" generic="T extends Model<T>, U = Array<string>">
import { a } from '@/dep-a'
defineProps<{ item: T; other?: U }>()
</script>
`);
    expect(deps).toEqual(['src/dep-a.ts']);
  });

  it('handles template before script, and both a plain and a setup block', async () => {
    const deps = await importsOf(`<template>
  <div v-if="a > b">text</div>
</template>
<script lang="ts">
import { a } from '@/dep-a'
export default { name: 'P' }
</script>
<script setup lang="ts">
import { b } from '@/dep-b'
</script>
<style scoped>.x { color: red }</style>`);
    expect(deps).toEqual(['src/dep-a.ts', 'src/dep-b.ts']);
  });

  it('handles attributes in any order, with either quote style', async () => {
    const deps = await importsOf(`<script   lang='ts'
  setup
  generic='T extends { id: number }'
>
import { a } from '@/dep-a'
</script>
<script setup generic="X extends Y<Z>" lang="ts">
import { b } from '@/dep-b'
</script>`);
    expect(deps).toEqual(['src/dep-a.ts', 'src/dep-b.ts']);
  });

  it('ignores a <script> inside an HTML comment', async () => {
    const deps = await importsOf(`<!-- <script setup>import { a } from '@/dep-a'</script> -->
<script setup>
import { b } from '@/dep-b'
</script>`);
    expect(deps).toEqual(['src/dep-b.ts']);
  });

  it('parses TypeScript syntax in script bodies', async () => {
    const deps = await importsOf(`<script setup lang="ts">
import { a } from '@/dep-a'
import type { B } from '@/dep-b'
import { c } from '@/dep-c'
enum Kind { One, Two }
interface Props<T> { items: T[]; cb?: (x: T) => void }
const id = <T,>(x: T): T => x
const n = (document.body as unknown as HTMLElement).id!
function f<T extends object = {}>(this: Window, x?: T): asserts x is T {}
const props = defineProps<Props<string>>()
</script>`);
    expect(deps).toEqual(['src/dep-a.ts', 'src/dep-c.ts']);
  });

  it('follows <script src> with unquoted or single-quoted values', async () => {
    write(root, 'src/router/index.js', `import P from '@/P.vue'\nexport default [{ path: '/p', component: P }]`);
    write(root, 'src/P.vue', `<script lang=ts src=./logic.ts></script>`);
    write(root, 'src/logic.ts', 'export {}');
    const graph = await build();
    expect(graph.fileToRoutes.get('src/logic.ts')).toEqual(['/p']);
  });
});

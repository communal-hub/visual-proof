import fs from 'node:fs';
import path from 'node:path';

/** Pages that render the shared picker. */
export const PAGES = 200;
/** The component they share. */
export const PICKER = 'src/components/DatePicker.vue';

/** Add 200 pages, `/gen/p0` to `/gen/p199`, each rendering one shared date picker, to a copy of the fixture. */
export function generateRoutes(dir: string): void {
  fs.writeFileSync(
    path.join(dir, PICKER),
    '<template>\n  <label class="picker" data-test="picker">Pick a date <input type="date" /></label>\n</template>\n',
  );
  fs.mkdirSync(path.join(dir, 'src/pages/gen'), { recursive: true });
  const imports: string[] = [];
  const routes: string[] = [];
  for (let i = 0; i < PAGES; i++) {
    fs.writeFileSync(
      path.join(dir, `src/pages/gen/P${i}.vue`),
      `<script setup>\nimport DatePicker from '../../components/DatePicker.vue'\n</script>\n\n<template>\n  <main data-test="gen"><h1>Generated page ${i}</h1><DatePicker /></main>\n</template>\n`,
    );
    imports.push(`import P${i} from '../pages/gen/P${i}.vue'`);
    routes.push(`  { path: '/gen/p${i}', component: P${i} },`);
  }
  fs.writeFileSync(path.join(dir, 'src/router/generated.js'), `${imports.join('\n')}\n\nexport default [\n${routes.join('\n')}\n]\n`);
  const index = path.join(dir, 'src/router/index.js');
  fs.writeFileSync(
    index,
    fs
      .readFileSync(index, 'utf8')
      .replace("import { createRouter, createWebHistory } from 'vue-router'", "import { createRouter, createWebHistory } from 'vue-router'\nimport generated from './generated.js'")
      .replace('const routes = [', 'const routes = [\n  ...generated,'),
  );
}

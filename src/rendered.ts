import fs from 'node:fs';
import path from 'node:path';

/** Most distinct component files kept per frame. */
export const MAX_RENDERED_FILES = 2000;

/**
 * In-page script: the `type.__file` of every component mounted in the Vue 3 app on `appRoot`, as the raw
 * strings @vitejs/plugin-vue stamped on them (absolute paths in dev). Returns null when there is no Vue 3
 * app (`__vue_app__`) or no component carries a `__file` (a production build, a non-Vue app).
 *
 * Walks the mounted tree from `app._instance`: a component instance continues with its `subTree`; a vnode
 * continues with its `component`, its `suspense.activeBranch` (what Suspense shows now: content or fallback)
 * and its array `children` (elements, fragments, Teleport content). KeepAlive needs no case: its instance's
 * `subTree` is the active child, and cached inactive children are not on screen. Iterative, so a deep tree
 * cannot overflow the stack.
 *
 * NOTE: a string on purpose, like the other in-page scripts: under tsx/esbuild `keepNames`, functions passed
 * to `page.evaluate` get `__name(...)` helper calls injected that do not exist in the page.
 */
export function renderedFilesScript(appRoot: string, limit = MAX_RENDERED_FILES * 2): string {
  return `(() => {
    const appRoot = ${JSON.stringify(appRoot)};
    let root = null;
    try {
      root = document.querySelector(appRoot);
    } catch (e) {
      root = null;
    }
    const app = root && root.__vue_app__;
    if (!app) return null;

    const files = new Set();
    const seen = new Set();
    const stack = [];
    const record = (instance) => {
      const file = instance && instance.type && instance.type.__file;
      if (typeof file === 'string' && file !== '' && files.size < ${limit}) files.add(file);
    };
    if (app._instance) {
      seen.add(app._instance);
      record(app._instance);
      stack.push(app._instance.subTree);
    } else if (root._vnode) {
      stack.push(root._vnode);
    }
    while (stack.length > 0) {
      const vnode = stack.pop();
      if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) continue;
      seen.add(vnode);
      const instance = vnode.component;
      if (instance && !seen.has(instance)) {
        seen.add(instance);
        record(instance);
        stack.push(instance.subTree);
      }
      if (vnode.suspense) stack.push(vnode.suspense.activeBranch);
      if (Array.isArray(vnode.children)) for (const child of vnode.children) stack.push(child);
    }
    return files.size === 0 ? null : [...files];
  })()`;
}

/**
 * Raw `__file` strings as repo-relative POSIX paths (relative to the config directory), deduplicated, sorted
 * and capped. Files outside the repo (node_modules, other packages) are dropped. Null when nothing is inside
 * the repo: the paths then cannot be compared with changed files (Vite in a container with other mount
 * points, say) and the render check has to skip rather than fail every file.
 */
export function normalizeRenderedFiles(raw: readonly string[] | null | undefined, repoDir: string): string[] | null {
  if (!raw || raw.length === 0) return null;
  const roots = new Set([repoDir]);
  try {
    roots.add(fs.realpathSync(repoDir));
  } catch {
    // The repo dir is gone; the plain path is all there is.
  }
  const out = new Set<string>();
  for (const file of raw) {
    const posix = file.replace(/\\/g, '/');
    let rel: string | null = null;
    if (path.isAbsolute(file) || path.posix.isAbsolute(posix)) {
      for (const root of roots) {
        const candidate = path.relative(root, file).replace(/\\/g, '/');
        if (candidate !== '' && !candidate.startsWith('..') && !path.isAbsolute(candidate)) {
          rel = candidate;
          break;
        }
      }
    } else {
      rel = posix.replace(/^\.\//, '');
    }
    if (rel) out.add(rel);
  }
  if (out.size === 0) return null;
  return [...out].sort().slice(0, MAX_RENDERED_FILES);
}

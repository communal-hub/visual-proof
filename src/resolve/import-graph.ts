import fs from 'node:fs';
import path from 'node:path';
import { init, parse } from 'es-module-lexer';
import picomatch from 'picomatch';

export interface RouteInfo {
  /** Full route pattern with parent paths joined, e.g. `/invoices/:id`. */
  path: string;
  /** Repo-relative route file that declares it. */
  routeFile: string;
  /** Repo-relative page component, or null when it could not be resolved. */
  component: string | null;
  /** Ancestor route components (layouts) that also render on this route. */
  layouts: string[];
  /** True when the page component is loaded through `import()`. */
  dynamic: boolean;
}

export interface ImportGraph {
  /** Repo-relative POSIX file -> sorted route patterns that (transitively) render it. */
  fileToRoutes: Map<string, string[]>;
  routes: RouteInfo[];
  /** Human-readable notes about imports or components the graph could not follow. */
  unresolved: string[];
}

export interface ImportGraphOptions {
  repoDir: string;
  routeFiles: string[];
  srcRoots: string[];
  aliases: Record<string, string>;
}

const PARSEABLE = new Set(['.vue', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.tsx']);
const RESOLVE_EXTENSIONS = ['.vue', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx'];

/** A specifier ending in the key may really point at a source file with one of the values. */
const TS_EXTENSION_SWAPS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx'],
};

interface ModuleImport {
  specifier: string;
  dynamic: boolean;
  /** Local binding names introduced by a static import. */
  locals: string[];
}

export async function buildImportGraph(options: ImportGraphOptions): Promise<ImportGraph> {
  await init();
  const graph = new GraphBuilder(options);
  return graph.build();
}

class GraphBuilder {
  private readonly unresolved = new Set<string>();
  private readonly importsCache = new Map<string, ModuleImport[]>();
  private readonly depsCache = new Map<string, string[]>();

  constructor(private readonly options: ImportGraphOptions) {}

  build(): ImportGraph {
    const routes = this.findRouteFiles().flatMap((file) => this.extractRoutes(file));

    const sets = new Map<string, Set<string>>();
    for (const route of routes) {
      const roots = [route.component, ...route.layouts].filter((f): f is string => f !== null);
      for (const file of this.reachable(roots)) {
        if (!sets.has(file)) sets.set(file, new Set());
        sets.get(file)!.add(route.path);
      }
    }

    const fileToRoutes = new Map<string, string[]>();
    for (const [file, paths] of [...sets].sort(([a], [b]) => (a < b ? -1 : 1))) {
      fileToRoutes.set(file, [...paths].sort());
    }
    return { fileToRoutes, routes, unresolved: [...this.unresolved].sort() };
  }

  // ---- route files ---------------------------------------------------------

  private findRouteFiles(): string[] {
    const matches = picomatch(this.options.routeFiles, { dot: true });
    const found = new Set<string>();
    for (const glob of this.options.routeFiles) {
      for (const file of this.walk(globBase(glob))) {
        if (matches(file)) found.add(file);
      }
    }
    return [...found].sort();
  }

  private walk(rel: string): string[] {
    const abs = this.abs(rel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return [];
    }
    if (stat.isFile()) return [rel];
    const files: string[] = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      files.push(...this.walk(rel === '' ? entry.name : `${rel}/${entry.name}`));
    }
    return files;
  }

  private extractRoutes(routeFile: string): RouteInfo[] {
    const code = this.read(routeFile);
    if (code === null) return [];
    const imports = this.parseImports(routeFile, code);

    const bindings = new Map<string, { file: string; dynamic: boolean }>();
    for (const imp of imports) {
      if (imp.dynamic) continue;
      const file = this.resolve(imp.specifier, routeFile);
      if (file) for (const local of imp.locals) bindings.set(local, { file, dynamic: false });
    }
    for (const [name, specifier] of lazyBindings(code)) {
      const file = this.resolve(specifier, routeFile);
      if (file) bindings.set(name, { file, dynamic: true });
    }

    const nodes = scanObjects(code);
    const routeNodes = nodes.filter(isRouteNode);
    const routeParentOf = new Map<ObjectNode, ObjectNode | null>();
    for (const node of routeNodes) routeParentOf.set(node, nearestRouteAncestor(node));
    const hasChildren = new Set([...routeParentOf.values()].filter((p): p is ObjectNode => p !== null));

    const fullPaths = new Map<ObjectNode, string>();
    const fullPath = (node: ObjectNode): string => {
      const cached = fullPaths.get(node);
      if (cached !== undefined) return cached;
      const parent = routeParentOf.get(node) ?? null;
      const joined = joinRoutePath(parent ? fullPath(parent) : null, literal(node.props.get('path')!) ?? '');
      fullPaths.set(node, joined);
      return joined;
    };

    const componentOf = (node: ObjectNode): { file: string | null; dynamic: boolean } => {
      const value = node.props.get('component');
      if (value === undefined) return { file: null, dynamic: false };
      const bound = IDENTIFIER.test(value) ? bindings.get(value) : undefined;
      if (bound) return bound;
      const lazy = INLINE_IMPORT.exec(value);
      if (lazy) {
        const file = this.resolve(lazy[2]!, routeFile);
        return { file, dynamic: true };
      }
      this.unresolved.add(`${routeFile}: cannot resolve component ${truncate(value)}`);
      return { file: null, dynamic: false };
    };

    const routes: RouteInfo[] = [];
    for (const node of routeNodes) {
      if (literal(node.props.get('path')!) === null) {
        this.unresolved.add(`${routeFile}: non-literal route path ${truncate(node.props.get('path')!)}`);
        continue;
      }
      if (hasChildren.has(node) || !node.props.has('component')) continue;

      const layouts: string[] = [];
      for (let p = routeParentOf.get(node) ?? null; p; p = routeParentOf.get(p) ?? null) {
        const { file } = componentOf(p);
        if (file) layouts.push(file);
      }
      const { file, dynamic } = componentOf(node);
      routes.push({ path: fullPath(node), routeFile, component: file, layouts, dynamic });
    }
    return routes;
  }

  // ---- transitive imports --------------------------------------------------

  private reachable(roots: string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...this.dependencies(file));
    }
    return seen;
  }

  private dependencies(file: string): string[] {
    const cached = this.depsCache.get(file);
    if (cached) return cached;
    const deps: string[] = [];
    if (PARSEABLE.has(path.posix.extname(file))) {
      const code = this.read(file);
      if (code !== null) {
        for (const imp of this.parseImports(file, code)) {
          const resolved = this.resolve(imp.specifier, file);
          if (resolved) deps.push(resolved);
        }
      }
    }
    this.depsCache.set(file, deps);
    return deps;
  }

  private parseImports(file: string, code: string): ModuleImport[] {
    const cached = this.importsCache.get(file);
    if (cached) return cached;
    const sources = file.endsWith('.vue') ? vueScripts(code) : [code];
    const imports: ModuleImport[] = [];
    for (const source of sources) {
      try {
        for (const imp of parse(source)[0]) {
          if (imp.type === 'import-meta') continue;
          if (imp.type === 'dynamic') {
            if (imp.specifier === undefined) {
              this.unresolved.add(`${file}: dynamic import with a computed specifier`);
            } else if (imp.glob) {
              this.unresolved.add(`${file}: dynamic import glob ${imp.specifier}`);
            } else if (!imp.probablyTypeOnly) {
              imports.push({ specifier: imp.specifier, dynamic: true, locals: [] });
            }
          } else if (!imp.typeOnly) {
            const clause = source.slice(imp.importStart, imp.start);
            imports.push({ specifier: imp.specifier, dynamic: false, locals: importLocals(clause) });
          }
        }
      } catch (err) {
        this.unresolved.add(`${file}: parse error (${(err as Error).message.split('\n')[0]})`);
      }
    }
    this.importsCache.set(file, imports);
    return imports;
  }

  // ---- specifier resolution ------------------------------------------------

  /** Repo-relative file for a specifier, or null for externals and misses (misses are recorded). */
  private resolve(rawSpecifier: string, from: string): string | null {
    const specifier = rawSpecifier.replace(/(?<=.)[?#].*$/, '');
    let candidate: string | null;

    if (specifier.startsWith('.')) {
      candidate = path.posix.join(path.posix.dirname(from), specifier);
    } else if (specifier.startsWith('/')) {
      candidate = path.posix.normalize(specifier.slice(1));
    } else {
      candidate = this.applyAlias(specifier);
      if (candidate === null) {
        // Bare specifier: a project-local module only if it exists under a source root.
        for (const root of this.options.srcRoots) {
          const hit = this.probe(path.posix.join(toPosix(root), specifier));
          if (hit) return hit;
        }
        return null;
      }
    }

    if (candidate === '..' || candidate.startsWith('../')) return null;
    const hit = this.probe(candidate);
    if (!hit) this.unresolved.add(`${from}: cannot resolve import '${rawSpecifier}'`);
    return hit;
  }

  private applyAlias(specifier: string): string | null {
    const keys = Object.keys(this.options.aliases).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const matches = specifier === key || specifier.startsWith(key.endsWith('/') ? key : `${key}/`);
      if (!matches) continue;
      const target = this.options.aliases[key]!;
      const relTarget = path.isAbsolute(target)
        ? toPosix(path.relative(this.options.repoDir, target))
        : path.posix.normalize(toPosix(target));
      return path.posix.join(relTarget, specifier.slice(key.length));
    }
    return null;
  }

  /** Resolve a repo-relative path to an existing file, trying extensions and index files. */
  private probe(rel: string): string | null {
    const normalized = path.posix.normalize(rel);
    if (this.isFile(normalized)) return normalized;
    // TypeScript ESM convention: `./Form.js` names the compiled output of `./Form.ts`.
    const originalExt = path.posix.extname(normalized);
    const swap = TS_EXTENSION_SWAPS[originalExt];
    if (swap) {
      const stem = normalized.slice(0, -originalExt.length);
      for (const ext of swap) if (this.isFile(stem + ext)) return stem + ext;
    }
    for (const ext of RESOLVE_EXTENSIONS) {
      if (this.isFile(normalized + ext)) return normalized + ext;
    }
    for (const ext of RESOLVE_EXTENSIONS) {
      const index = path.posix.join(normalized, `index${ext}`);
      if (this.isFile(index)) return index;
    }
    return null;
  }

  private isFile(rel: string): boolean {
    try {
      return fs.statSync(this.abs(rel)).isFile();
    } catch {
      return false;
    }
  }

  private read(rel: string): string | null {
    try {
      return fs.readFileSync(this.abs(rel), 'utf8');
    } catch {
      this.unresolved.add(`${rel}: cannot read file`);
      return null;
    }
  }

  private abs(rel: string): string {
    return path.join(this.options.repoDir, rel);
  }
}

// ---- import clause / SFC helpers -------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const INLINE_IMPORT = /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(['"])([^'"`$]+)\1\s*\)/;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}...` : oneLine;
}

/** Leading non-glob directory of a glob, used to avoid walking the whole repo. */
function globBase(glob: string): string {
  const segments = glob.split('/');
  const base: string[] = [];
  for (const segment of segments) {
    if (/[*?{}[\]()!]/.test(segment)) break;
    base.push(segment);
  }
  return base.join('/').replace(/^\.\//, '');
}

/** Local binding names from the text of an import statement up to its specifier quote. */
function importLocals(clause: string): string[] {
  const body = clause.replace(/^\s*import\s+/, '').replace(/\s*from\s*['"]?\s*$/, '');
  const locals: string[] = [];
  const named = /\{([^}]*)\}/.exec(body);
  if (named) {
    for (const part of named[1]!.split(',')) {
      const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (m) locals.push(m[2] ?? m[1]!);
    }
  }
  const rest = body.replace(/\{[^}]*\}/, '');
  const ns = /\*\s*as\s+([\w$]+)/.exec(rest);
  if (ns) locals.push(ns[1]!);
  const def = /^\s*([\w$]+)\s*(?:,|$)/.exec(rest);
  if (def && def[1] !== 'type') locals.push(def[1]!);
  return locals;
}

/** `const Foo = () => import('./Foo.vue')` style lazy components: name -> specifier. */
function lazyBindings(code: string): Map<string, string> {
  const result = new Map<string, string>();
  const re =
    /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:\(\s*\)\s*=>|defineAsyncComponent\(\s*(?:\(\s*\)\s*=>)?)\s*import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(['"])([^'"`$]+)\2/g;
  for (const m of code.matchAll(re)) result.set(m[1]!, m[3]!);
  return result;
}

/**
 * Contents of every top-level `<script>` / `<script setup>` block; `<script src>` becomes a
 * synthetic import. Scanned sequentially rather than with one regex so that:
 *  - attribute values may contain `>` (`generic="T extends Model<T>"`),
 *  - attributes can come in any order and use either quote style,
 *  - HTML comments (and any `<script` text inside them) are skipped,
 *  - a `<script>` that follows a large `<template>` is still found.
 */
function vueScripts(code: string): string[] {
  const blocks: string[] = [];
  const open = /<!--|<script(?=[\s>/])/g;
  const tagEnd = /(?:"[^"]*"|'[^']*'|[^>"'])*>/y;
  let pos = 0;
  while (pos < code.length) {
    open.lastIndex = pos;
    const m = open.exec(code);
    if (!m) break;
    if (m[0] === '<!--') {
      const end = code.indexOf('-->', m.index + 4);
      pos = end === -1 ? code.length : end + 3;
      continue;
    }
    tagEnd.lastIndex = m.index + m[0].length;
    const tag = tagEnd.exec(code);
    if (!tag) break;
    const attrs = tag[0].slice(0, -1);
    const bodyStart = tagEnd.lastIndex;
    const close = /<\/script\s*>/gi;
    close.lastIndex = bodyStart;
    const closing = close.exec(code);
    const bodyEnd = closing ? closing.index : code.length;
    pos = closing ? closing.index + closing[0].length : code.length;

    if (attrs.endsWith('/')) continue; // self-closing: no body
    const src = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/.exec(attrs);
    const srcValue = src ? (src[1] ?? src[2] ?? src[3]) : undefined;
    blocks.push(srcValue ? `import ${JSON.stringify(srcValue)};` : code.slice(bodyStart, bodyEnd));
  }
  return blocks;
}

// ---- route object scanning -------------------------------------------------

interface ObjectNode {
  parent: ObjectNode | null;
  /** Top-level `key: value` pairs; values are raw trimmed source text. */
  props: Map<string, string>;
}

function isRouteNode(node: ObjectNode): boolean {
  return (
    node.props.has('path') &&
    (node.props.has('component') || node.props.has('children') || node.props.has('redirect'))
  );
}

function nearestRouteAncestor(node: ObjectNode): ObjectNode | null {
  for (let p = node.parent; p; p = p.parent) if (isRouteNode(p)) return p;
  return null;
}

/**
 * The value of a plain string literal (no interpolation), else null. `\\`, `\'`, `\"` and `\`` escapes are decoded,
 * which is what a Vue Router custom regex param needs: `'/users/:id(\\d+)'` is the route key `/users/:id(\d+)`.
 */
function literal(text: string): string | null {
  const m = /^(['"`])((?:[^'"`$\\]|\\[\\'"`])*)\1$/.exec(text);
  return m ? m[2]!.replace(/\\(['"`\\])/g, '$1') : null;
}

function joinRoutePath(parent: string | null, own: string): string {
  let joined: string;
  if (own.startsWith('/')) joined = own;
  else if (parent === null) joined = `/${own}`;
  else joined = own === '' ? parent : `${parent}/${own}`;
  joined = joined.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/**
 * Find every `{ ... }` in the code and its top-level properties. This is deliberately not a JS
 * parser: strings and comments are skipped, brackets are balanced, and properties are split on
 * depth-0 commas. Function bodies show up as objects too but never have route-shaped props.
 */
function scanObjects(source: string): ObjectNode[] {
  const code = blankComments(source);
  const nodes: ObjectNode[] = [];
  interface Frame {
    open: string;
    node?: ObjectNode;
    segmentStart: number;
  }
  const stack: Frame[] = [];

  const closeSegment = (frame: Frame, end: number): void => {
    if (!frame.node) return;
    const segment = code.slice(frame.segmentStart, end).trim();
    const keyed = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/.exec(segment);
    if (keyed) frame.node.props.set(keyed[2] ?? keyed[3]!, keyed[4]!.trim());
    else if (IDENTIFIER.test(segment)) frame.node.props.set(segment, segment);
  };

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i);
    } else if (ch === '{') {
      let parent: ObjectNode | null = null;
      for (let s = stack.length - 1; s >= 0 && !parent; s--) parent = stack[s]!.node ?? null;
      const node: ObjectNode = { parent, props: new Map() };
      nodes.push(node);
      stack.push({ open: ch, node, segmentStart: i + 1 });
    } else if (ch === '[' || ch === '(') {
      stack.push({ open: ch, segmentStart: i + 1 });
    } else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top) {
        closeSegment(top, i);
        top.segmentStart = i + 1;
      }
    } else if (ch === '}' || ch === ']' || ch === ')') {
      const top = stack.pop();
      if (top) closeSegment(top, i);
    }
  }
  return nodes;
}

function skipString(code: string, start: number): number {
  const quote = code[start]!;
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === '\\') i++;
    else if (code[i] === quote) return i;
    else if (quote !== '`' && code[i] === '\n') return i;
  }
  return code.length;
}

/** Replace comments with spaces (preserving offsets) so they cannot break key matching. */
function blankComments(code: string): string {
  const out = code.split('');
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i);
    } else if (ch === '/' && code[i + 1] === '/') {
      for (; i < code.length && code[i] !== '\n'; i++) out[i] = ' ';
    } else if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      for (; i < stop; i++) if (code[i] !== '\n') out[i] = ' ';
      i--;
    }
  }
  return out.join('');
}

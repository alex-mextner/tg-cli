// Recursive file resolution for the auto-attach scanner
// (spec: docs/specs/auto-attach.md §"Recursive resolution").
//
// Third resolution fallback after plain cwd/~/absolute and worktree-root
// joins: a bare filename (`design.md`) or relative path (`specs/design.md`)
// mentioned in a message is searched for recursively under the SAME
// priority-ordered worktree roots, with secrets of the walk kept boring:
// pruned vendor/VCS directories, a depth cap, and a global visited-entries
// cap. Everything here is PURE — directory listing is injected, the tg
// entrypoint owns the real readdir and memoizes one index per process.

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

// Injectable directory lister: absolute path → entries, or null when the
// path is unreadable / not a directory. The real impl wraps readdirSync.
export type ListDir = (absPath: string) => DirEntry[] | null;

// Extensions worth a tree walk. Deliberately NARROWER than the worktree
// fallback's looksPathLike gate: recursion is the most expensive resolver, so
// only mainstream source/doc/asset extensions qualify.
const RECURSIVE_EXT =
  /\.(md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|json|yaml|yml|toml|sh|sql|csv|html|css|svg|png|jpg|jpeg|gif|webp|pdf|log)$/i;

// Directories never descended into. Matching is by exact name at any depth.
const DENY_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'vendor',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.idea',
  '.vscode',
  'tmp',
]);

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_ENTRIES = 50_000;

export interface IndexOpts {
  maxDepth?: number;
  maxEntries?: number;
}

/**
 * Gate: is this token worth a recursive search at all? Relative, no `..`
 * traversal, and a recursion-worthy extension. Absolute and ~-rooted tokens
 * belong to the plain resolver; `..` is rejected for the same containment
 * reason as the worktree fallback.
 */
export function isRecursiveCandidate(token: string): boolean {
  if (!token) return false;
  if (token.startsWith('/') || token === '~' || token.startsWith('~/')) return false;
  if (token.split(/[/\\]/).some((seg) => seg === '..')) return false;
  return RECURSIVE_EXT.test(token);
}

/**
 * Build the file index: BFS per root (shallower files first), directory
 * entries sorted byte-wise for determinism, roots concatenated in the given
 * priority order (duplicates skipped). The visited-entries cap counts every
 * file/dir seen across ALL roots; hitting it truncates the index silently —
 * a miss past the cap is a miss, never an error.
 */
export function buildFileIndex(roots: string[], listDir: ListDir, opts: IndexOpts = {}): string[] {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const index: string[] = [];
  const seenRoots = new Set<string>();
  let visited = 0;

  for (const root of roots) {
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    // BFS queue of [absDir, depth]. Depth 0 = the root itself.
    const queue: Array<[string, number]> = [[root, 0]];
    while (queue.length > 0) {
      const [dir, depth] = queue.shift() as [string, number];
      const entries = listDir(dir);
      if (entries === null) continue;
      const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of sorted) {
        if (visited >= maxEntries) return index;
        visited += 1;
        const abs = `${dir}/${e.name}`;
        if (e.isFile) {
          index.push(abs);
        } else if (e.isDirectory && depth < maxDepth && !DENY_DIRS.has(e.name)) {
          queue.push([abs, depth + 1]);
        }
      }
    }
  }
  return index;
}

/**
 * First index entry whose path ends with `/<token>` wins. BFS index order
 * makes that the shallowest match in the highest-priority root. The leading
 * separator pins the match to a path-segment boundary, so a bare filename
 * matches by basename and `specs/x.md` by suffix — but `ecs/x.md` never
 * matches `specs/x.md`. Backslashes in the token are normalized to `/`.
 */
export function matchFromIndex(token: string, index: string[]): string | null {
  const suffix = `/${token.replace(/\\/g, '/')}`;
  for (const abs of index) {
    if (abs.endsWith(suffix)) return abs;
  }
  return null;
}

import { expect, test } from 'bun:test';
import {
  buildFileIndex,
  isRecursiveCandidate,
  matchFromIndex,
  type DirEntry,
  type ListDir,
} from '../features/auto-attach/recursive';

// --- fake fs: a nested object tree → ListDir ---
// { "docs": { "specs": { "a.md": true } }, "b.md": true }
type Tree = { [name: string]: Tree | true };

function fakeListDir(roots: Record<string, Tree>): ListDir {
  const lookup = (abs: string): Tree | true | null => {
    for (const [root, tree] of Object.entries(roots)) {
      if (abs === root) return tree;
      if (abs.startsWith(root + '/')) {
        let node: Tree | true = tree;
        for (const seg of abs.slice(root.length + 1).split('/')) {
          if (node === true || node[seg] === undefined) return null;
          node = node[seg];
        }
        return node;
      }
    }
    return null;
  };
  return (abs: string): DirEntry[] | null => {
    const node = lookup(abs);
    if (node === null || node === true) return null;
    return Object.entries(node).map(([name, v]) => ({
      name,
      isFile: v === true,
      isDirectory: v !== true,
    }));
  };
}

// --- isRecursiveCandidate: extension + shape gate ---
test('isRecursiveCandidate accepts bare names and relative paths with known extensions', () => {
  expect(isRecursiveCandidate('design.md')).toBe(true);
  expect(isRecursiveCandidate('specs/design.md')).toBe(true);
  expect(isRecursiveCandidate('a.PNG')).toBe(true); // case-insensitive
  expect(isRecursiveCandidate('module.ts')).toBe(true);
});

test('isRecursiveCandidate rejects absolute, ~, .., unknown ext, extensionless', () => {
  expect(isRecursiveCandidate('/abs/design.md')).toBe(false);
  expect(isRecursiveCandidate('~/design.md')).toBe(false);
  expect(isRecursiveCandidate('../up/design.md')).toBe(false);
  expect(isRecursiveCandidate('design.xyz123')).toBe(false);
  expect(isRecursiveCandidate('Makefile')).toBe(false);
  expect(isRecursiveCandidate('')).toBe(false);
});

// --- buildFileIndex: BFS order, deny dirs, caps ---
test('index lists files BFS-shallow-first, entries sorted', () => {
  const listDir = fakeListDir({
    '/r': { 'z.md': true, docs: { 'a.md': true }, 'b.md': true },
  });
  expect(buildFileIndex(['/r'], listDir)).toEqual(['/r/b.md', '/r/z.md', '/r/docs/a.md']);
});

test('index never descends into denylisted directories', () => {
  const listDir = fakeListDir({
    '/r': {
      node_modules: { pkg: { 'README.md': true } },
      '.git': { 'config.md': true },
      dist: { 'x.md': true },
      docs: { 'real.md': true },
    },
  });
  expect(buildFileIndex(['/r'], listDir)).toEqual(['/r/docs/real.md']);
});

test('index concatenates roots in priority order and skips duplicate roots', () => {
  const listDir = fakeListDir({
    '/wt': { 'a.md': true },
    '/main': { 'b.md': true },
  });
  expect(buildFileIndex(['/wt', '/main', '/wt'], listDir)).toEqual(['/wt/a.md', '/main/b.md']);
});

test('index respects the depth cap', () => {
  const listDir = fakeListDir({
    '/r': { d1: { d2: { 'deep.md': true } }, 'top.md': true },
  });
  expect(buildFileIndex(['/r'], listDir, { maxDepth: 1 })).toEqual(['/r/top.md']);
});

test('index stops at the visited-entries cap without erroring', () => {
  const wide: Tree = {};
  for (let i = 0; i < 100; i++) wide[`f${String(i).padStart(3, '0')}.md`] = true;
  const listDir = fakeListDir({ '/r': wide });
  const index = buildFileIndex(['/r'], listDir, { maxEntries: 10 });
  expect(index.length).toBe(10);
});

test('unreadable root yields an empty contribution, not an error', () => {
  const listDir = fakeListDir({ '/r': { 'a.md': true } });
  expect(buildFileIndex(['/gone', '/r'], listDir)).toEqual(['/r/a.md']);
});

// --- matchFromIndex: suffix semantics ---
const INDEX = [
  '/r/notes.md',
  '/r/docs/specs/design.md',
  '/r/other/design.md.bak',
  '/r/deep/specs/design.md',
];

test('bare filename matches by basename, first (shallowest) index entry wins', () => {
  expect(matchFromIndex('design.md', INDEX)).toBe('/r/docs/specs/design.md');
});

test('relative token matches by path suffix at a segment boundary', () => {
  expect(matchFromIndex('specs/design.md', INDEX)).toBe('/r/docs/specs/design.md');
  expect(matchFromIndex('deep/specs/design.md', INDEX)).toBe('/r/deep/specs/design.md');
});

test('suffix match never crosses a partial segment', () => {
  // "ign.md" is a tail of "design.md" but not a path segment — no match.
  expect(matchFromIndex('ign.md', INDEX)).toBeNull();
  // "ecs/design.md" must not match "specs/design.md".
  expect(matchFromIndex('ecs/design.md', INDEX)).toBeNull();
});

test('miss returns null', () => {
  expect(matchFromIndex('absent.md', INDEX)).toBeNull();
  expect(matchFromIndex('absent.md', [])).toBeNull();
});

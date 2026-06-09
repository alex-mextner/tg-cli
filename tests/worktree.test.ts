import { expect, test } from 'bun:test';
import {
  enumerateWorktreeRoots,
  looksPathLike,
  orderWorktreeRoots,
  parseWorktreePorcelain,
  resolveAcrossWorktrees,
  type RunGit,
  type WorktreeEntry,
} from '../features/auto-attach/worktree';

// --- parseWorktreePorcelain -------------------------------------------------

test('parseWorktreePorcelain: main first, then feature worktree with branches', () => {
  const out = [
    'worktree /repo/main',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt-feature',
    'HEAD def456',
    'branch refs/heads/feat/x',
    '',
  ].join('\n');
  const entries = parseWorktreePorcelain(out);
  expect(entries).toEqual([
    { root: '/repo/main', branch: 'main' },
    { root: '/repo/wt-feature', branch: 'feat/x' },
  ]);
});

test('parseWorktreePorcelain: detached and bare entries carry null branch', () => {
  const out = ['worktree /repo/main', 'HEAD abc', 'detached', '', 'worktree /repo/bare', 'bare', ''].join('\n');
  const entries = parseWorktreePorcelain(out);
  expect(entries).toEqual([
    { root: '/repo/main', branch: null },
    { root: '/repo/bare', branch: null },
  ]);
});

// --- orderWorktreeRoots (priority order) -----------------------------------

const ENTRIES: WorktreeEntry[] = [
  { root: '/repo/main', branch: 'main' },
  { root: '/repo/wt-feature', branch: 'feat/x' },
  { root: '/repo/wt-other', branch: 'feat/y' },
];

test('orderWorktreeRoots: current first, then main, then branch-match, then rest', () => {
  // cwd is the feature worktree on feat/x.
  const ordered = orderWorktreeRoots(ENTRIES, '/repo/wt-feature', 'feat/x');
  expect(ordered).toEqual(['/repo/wt-feature', '/repo/main', '/repo/wt-other']);
});

test('orderWorktreeRoots: from main, branch-match worktree comes before the rest', () => {
  // cwd IS the main worktree but on branch feat/x → its dedicated worktree (2)
  // should be probed right after current+main.
  const ordered = orderWorktreeRoots(ENTRIES, '/repo/main', 'feat/x');
  expect(ordered).toEqual(['/repo/main', '/repo/wt-feature', '/repo/wt-other']);
});

test('orderWorktreeRoots: current==main dedups to a single leading entry', () => {
  const ordered = orderWorktreeRoots(ENTRIES, '/repo/main', 'main');
  expect(ordered[0]).toBe('/repo/main');
  expect(ordered.filter((r) => r === '/repo/main')).toHaveLength(1);
});

// --- looksPathLike (the gate) ----------------------------------------------

test('looksPathLike: path with slash is path-like', () => {
  expect(looksPathLike('docs/specs/x.md')).toBe(true);
});

test('looksPathLike: bare filename with known extension is path-like', () => {
  expect(looksPathLike('README.md')).toBe(true);
});

test('looksPathLike: ordinary prose word is NOT path-like', () => {
  expect(looksPathLike('hello')).toBe(false);
  expect(looksPathLike('word.')).toBe(false);
});

test('looksPathLike: absolute / ~ tokens are excluded (plain resolver owns them)', () => {
  expect(looksPathLike('/abs/x.md')).toBe(false);
  expect(looksPathLike('~/x.md')).toBe(false);
  expect(looksPathLike('~')).toBe(false);
});

// --- resolveAcrossWorktrees -------------------------------------------------

test('resolveAcrossWorktrees: resolves in feature worktree when only present there', () => {
  const roots = ['/repo/main', '/repo/wt-feature'];
  const exists = (p: string) => p === '/repo/wt-feature/docs/x.md';
  expect(resolveAcrossWorktrees('docs/x.md', roots, exists)).toBe('/repo/wt-feature/docs/x.md');
});

test('resolveAcrossWorktrees: priority — first existing root wins', () => {
  const roots = ['/repo/main', '/repo/wt-feature'];
  // Present in BOTH → main (first in the ordered roots) wins.
  const exists = (p: string) => p === '/repo/main/docs/x.md' || p === '/repo/wt-feature/docs/x.md';
  expect(resolveAcrossWorktrees('docs/x.md', roots, exists)).toBe('/repo/main/docs/x.md');
});

test('resolveAcrossWorktrees: rejects ..-traversal escaping the root', () => {
  const roots = ['/repo/main'];
  // Even if the escaped path "exists", traversal must be refused.
  const exists = () => true;
  expect(resolveAcrossWorktrees('../outside/x.md', roots, exists)).toBeNull();
});

test('resolveAcrossWorktrees: absolute token is not our job → null', () => {
  expect(resolveAcrossWorktrees('/abs/x.md', ['/repo/main'], () => true)).toBeNull();
});

test('resolveAcrossWorktrees: no match → null', () => {
  expect(resolveAcrossWorktrees('docs/x.md', ['/repo/main'], () => false)).toBeNull();
});

// --- enumerateWorktreeRoots (injected git) ---------------------------------

function stubGit(map: Record<string, string | null>): RunGit {
  return (args) => {
    const key = args.join(' ');
    return key in map ? map[key] : null;
  };
}

test('enumerateWorktreeRoots: combines toplevel + branch + porcelain into priority order', () => {
  const cwd = '/repo/wt-feature';
  const git = stubGit({
    [`-C ${cwd} rev-parse --show-toplevel`]: '/repo/wt-feature\n',
    [`-C ${cwd} rev-parse --abbrev-ref HEAD`]: 'feat/x\n',
    [`-C ${cwd} worktree list --porcelain`]: [
      'worktree /repo/main',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-feature',
      'branch refs/heads/feat/x',
      '',
    ].join('\n'),
  });
  expect(enumerateWorktreeRoots(cwd, git)).toEqual(['/repo/wt-feature', '/repo/main']);
});

test('enumerateWorktreeRoots: not a git repo → empty list', () => {
  const git = stubGit({}); // every call returns null
  expect(enumerateWorktreeRoots('/tmp', git)).toEqual([]);
});

test('enumerateWorktreeRoots: detached HEAD → no branch-match, still ordered', () => {
  const cwd = '/repo/main';
  const git = stubGit({
    [`-C ${cwd} rev-parse --show-toplevel`]: '/repo/main\n',
    [`-C ${cwd} rev-parse --abbrev-ref HEAD`]: 'HEAD\n',
    [`-C ${cwd} worktree list --porcelain`]: [
      'worktree /repo/main',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-feature',
      'branch refs/heads/feat/x',
      '',
    ].join('\n'),
  });
  expect(enumerateWorktreeRoots(cwd, git)).toEqual(['/repo/main', '/repo/wt-feature']);
});

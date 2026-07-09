import { expect, test } from 'bun:test';
import {
  BANNER_ADVICE,
  buildGitStateBanner,
  buildPaneGitState,
  isPaneOccupiedWithWork,
  parseBranch,
  parseUncommittedCount,
} from '../features/tg-ctl/git-state';

// --- parseBranch ---

test('parseBranch trims the rev-parse output', () => {
  expect(parseBranch('main\n')).toBe('main');
  expect(parseBranch('feat/foo\n')).toBe('feat/foo');
});

test('parseBranch normalizes a detached HEAD to empty', () => {
  expect(parseBranch('HEAD\n')).toBe('');
});

// --- parseUncommittedCount ---

test('parseUncommittedCount counts non-empty porcelain lines', () => {
  expect(parseUncommittedCount('')).toBe(0);
  expect(parseUncommittedCount('\n')).toBe(0);
  expect(parseUncommittedCount(' M features/tg-ctl/updates.ts\n?? scratch.txt\n')).toBe(2);
});

test('parseUncommittedCount ignores blank lines within the output', () => {
  expect(parseUncommittedCount(' M a.ts\n\n?? b.ts\n\n')).toBe(2);
});

// --- buildPaneGitState ---

test('buildPaneGitState composes branch + uncommitted count from raw git stdout', () => {
  expect(buildPaneGitState('main\n', ' M a.ts\n')).toEqual({ branch: 'main', uncommittedCount: 1 });
  expect(buildPaneGitState('feat/x\n', '')).toEqual({ branch: 'feat/x', uncommittedCount: 0 });
});

// --- isPaneOccupiedWithWork ---

test('isPaneOccupiedWithWork: clean main/master is NOT occupied', () => {
  expect(isPaneOccupiedWithWork({ branch: 'main', uncommittedCount: 0 })).toBe(false);
  expect(isPaneOccupiedWithWork({ branch: 'master', uncommittedCount: 0 })).toBe(false);
});

test('isPaneOccupiedWithWork: uncommitted changes on main IS occupied', () => {
  expect(isPaneOccupiedWithWork({ branch: 'main', uncommittedCount: 3 })).toBe(true);
});

test('isPaneOccupiedWithWork: clean feature branch IS occupied', () => {
  expect(isPaneOccupiedWithWork({ branch: 'feat/foo', uncommittedCount: 0 })).toBe(true);
});

test('isPaneOccupiedWithWork: undeterminable (empty) branch with a clean tree is NOT occupied', () => {
  expect(isPaneOccupiedWithWork({ branch: '', uncommittedCount: 0 })).toBe(false);
});

test('isPaneOccupiedWithWork: undeterminable branch but uncommitted changes IS occupied', () => {
  expect(isPaneOccupiedWithWork({ branch: '', uncommittedCount: 1 })).toBe(true);
});

// --- buildGitStateBanner ---

test('BANNER_ADVICE gives operational routing guidance without the old finish/commit wording', () => {
  expect(BANNER_ADVICE).toContain('another project');
  expect(BANNER_ADVICE).toContain('clarify with the user');
  expect(BANNER_ADVICE).toContain('active subagent');
  expect(BANNER_ADVICE).toContain('new subagent');
  expect(BANNER_ADVICE).not.toContain('DIFFERENT task');
  expect(BANNER_ADVICE).not.toContain('finish/commit current work first');
});

test('buildGitStateBanner: null state → no banner', () => {
  expect(buildGitStateBanner(null)).toBeNull();
});

test('buildGitStateBanner: clean main/master → no banner', () => {
  expect(buildGitStateBanner({ branch: 'main', uncommittedCount: 0 })).toBeNull();
  expect(buildGitStateBanner({ branch: 'master', uncommittedCount: 0 })).toBeNull();
});

test('buildGitStateBanner: uncommitted changes → banner names the branch + file count', () => {
  const banner = buildGitStateBanner({ branch: 'feat/foo', uncommittedCount: 3 });
  expect(banner).not.toBeNull();
  expect(banner).toContain('⚠');
  expect(banner).toContain('uncommitted work on branch feat/foo');
  expect(banner).toContain('3 files changed');
  expect(banner).toContain(BANNER_ADVICE);
});

test('buildGitStateBanner: singular file count reads naturally', () => {
  const banner = buildGitStateBanner({ branch: 'main', uncommittedCount: 1 });
  expect(banner).toContain('1 file changed');
  expect(banner).not.toContain('1 files changed');
});

test('buildGitStateBanner: clean feature branch (0 files) still warns, with clean-tree wording', () => {
  const banner = buildGitStateBanner({ branch: 'feat/bar', uncommittedCount: 0 });
  expect(banner).not.toBeNull();
  expect(banner).toContain('branch feat/bar');
  expect(banner).toContain('tree clean');
  expect(banner).toContain(BANNER_ADVICE);
  // Must NOT claim "uncommitted work" when there is none.
  expect(banner).not.toContain('uncommitted work');
});

test('buildGitStateBanner: undeterminable branch + clean tree → no banner', () => {
  expect(buildGitStateBanner({ branch: '', uncommittedCount: 0 })).toBeNull();
});

test('buildGitStateBanner: dirty detached HEAD names it plainly, never a blank branch slot', () => {
  const banner = buildGitStateBanner({ branch: '', uncommittedCount: 1 });
  expect(banner).not.toBeNull();
  expect(banner).toContain('a detached HEAD');
  expect(banner).toContain('1 file changed');
  // Must never render the empty branch name as a bare double space (review catch).
  expect(banner).not.toContain('branch  (');
  expect(banner).not.toMatch(/branch\s{2,}/);
});

import { expect, test } from 'bun:test';
import { resolveWindowAgentLabel } from '../features/tg-ctl/agent-match';

// The OUTBOUND `[window]` header label (features/tg-ctl/agent-match.ts). A real
// user-chosen window name leads; a bare auto-rename default (version string /
// numeric index / shell name / empty) falls back to the cwd project basename —
// the fix for the `[2.1.207]` version leak (tmux automatic-rename sets a Claude
// Code pane's window name to the version it reports as its command).

test('a real user-chosen window name is used verbatim', () => {
  expect(resolveWindowAgentLabel('rig-cli', '/Users/ultra/xp/rig-cli')).toBe('rig-cli');
  expect(resolveWindowAgentLabel('api-bot', '/Users/ultra/xp/whatever')).toBe('api-bot');
});

test('a dotted version string (cc pane_current_command) falls back to the cwd basename', () => {
  // The exact bug: tmux auto-rename → window "2.1.207", cwd /Users/ultra/xp/rig-cli.
  expect(resolveWindowAgentLabel('2.1.207', '/Users/ultra/xp/rig-cli')).toBe('rig-cli');
});

test('a bare numeric window index falls back to the cwd basename', () => {
  expect(resolveWindowAgentLabel('4', '/a/b/my-project')).toBe('my-project');
});

test('a shell/launcher window name (node/zsh) falls back to the cwd basename', () => {
  expect(resolveWindowAgentLabel('node', '/a/b/proj')).toBe('proj');
  expect(resolveWindowAgentLabel('zsh', '/a/b/proj')).toBe('proj');
});

test('an empty window name falls back to the cwd basename', () => {
  expect(resolveWindowAgentLabel('', '/a/b/proj')).toBe('proj');
  expect(resolveWindowAgentLabel(null, '/a/b/proj')).toBe('proj');
});

test('a trailing slash on the cwd is stripped before taking the basename', () => {
  expect(resolveWindowAgentLabel('2.1.207', '/Users/ultra/xp/rig-cli/')).toBe('rig-cli');
});

test('nothing usable (bare window, empty cwd) → the bare window name, not a crash', () => {
  expect(resolveWindowAgentLabel('2.1.207', '')).toBe('2.1.207');
  expect(resolveWindowAgentLabel('', '')).toBe('');
  expect(resolveWindowAgentLabel('', null)).toBe('');
});

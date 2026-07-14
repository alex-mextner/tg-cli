import { expect, test } from 'bun:test';
import { agentNameForPane, agentNameFromDisplayLine } from '../features/tg-ctl/agent-name';

test('a real user-set window name is the agent name', () => {
  expect(agentNameForPane('rig', '/Users/u/xp/rig-cli')).toBe('rig');
  expect(agentNameForPane('api-bot', '/Users/u/work/api')).toBe('api-bot');
});

test('a bare/auto-rename window name falls back to the cwd project basename', () => {
  expect(agentNameForPane('node', '/Users/u/xp/rig-cli')).toBe('rig-cli');
  expect(agentNameForPane('zsh', '/Users/u/work/hyperide/')).toBe('hyperide');
  expect(agentNameForPane('4', '/Users/u/work/ext')).toBe('ext');
  expect(agentNameForPane('2.1.181', '/Users/u/work/ext')).toBe('ext');
});

test('an empty window name falls back to the cwd project basename', () => {
  expect(agentNameForPane('', '/Users/u/work/ext')).toBe('ext');
  expect(agentNameForPane(null, '/a/b/c')).toBe('c');
});

test('nothing usable → null', () => {
  expect(agentNameForPane('', '')).toBeNull();
  expect(agentNameForPane(null, null)).toBeNull();
});

test('a bare window name with no cwd hands back the bare name rather than null', () => {
  expect(agentNameForPane('4', '')).toBe('4');
});

test('agentNameFromDisplayLine parses window_name<TAB>pane_path', () => {
  expect(agentNameFromDisplayLine('rig\t/Users/u/xp/rig-cli\n')).toBe('rig');
  // trailing newline stripped, tab delimiter preserved
  expect(agentNameFromDisplayLine('api-bot\t/Users/u/work/api')).toBe('api-bot');
});

test('agentNameFromDisplayLine: EMPTY window name keeps the path in the right slot (regression)', () => {
  // A blanket .trim() would eat the leading tab and shift the path into the window-name slot,
  // yielding the path as the label; the cwd fallback must win instead.
  expect(agentNameFromDisplayLine('\t/Users/u/work/ext\n')).toBe('ext');
  expect(agentNameFromDisplayLine('\t/a/b/c')).toBe('c');
});

test('agentNameFromDisplayLine: a bare/auto-named window falls back to the cwd project', () => {
  expect(agentNameFromDisplayLine('node\t/Users/u/xp/rig-cli\n')).toBe('rig-cli');
});

test('agentNameFromDisplayLine: no tab → lone window name, both empty → null', () => {
  expect(agentNameFromDisplayLine('solo\n')).toBe('solo');
  expect(agentNameFromDisplayLine('\t\n')).toBeNull();
  expect(agentNameFromDisplayLine('')).toBeNull();
});

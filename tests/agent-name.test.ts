import { expect, test } from 'bun:test';
import { agentNameForPane } from '../features/tg-ctl/agent-name';

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

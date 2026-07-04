import { expect, test } from 'bun:test';
import { detectAgentLabel } from '../features/agent-detect/detect';

// --- Explicit override wins over every auto-detection path ---
test('TG_AGENT explicit override wins, even alongside Claude Code child-session signals', () => {
  expect(detectAgentLabel({ TG_AGENT: 'hyperide-fixer' })).toBe('hyperide-fixer');
  expect(
    detectAgentLabel({
      TG_AGENT: 'hyperide-fixer',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
    }),
  ).toBe('hyperide-fixer');
});

// --- TG_AGENT is trimmed, and whitespace-only falls through to auto-detect
// (review finding, tg#6254): must behave the SAME as --agent's own
// whitespace-only rejection, not render an empty `[   ]` bracket. ---
test('TG_AGENT padded with whitespace is trimmed', () => {
  expect(detectAgentLabel({ TG_AGENT: '  hyperide-fixer  ' })).toBe('hyperide-fixer');
});

test('a whitespace-only TG_AGENT falls through to auto-detection, not an empty bracket', () => {
  expect(detectAgentLabel({ TG_AGENT: '   ', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' })).toBe(
    'subagent',
  );
  expect(detectAgentLabel({ TG_AGENT: '\t' })).toBe('');
});

// --- Claude Code: the one reliable automatic signal ---
test('Claude Code subagent (CLAUDE_CODE_CHILD_SESSION set) auto-detects as "subagent"', () => {
  expect(detectAgentLabel({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' })).toBe('subagent');
});

test('Claude Code detected via CLAUDE_CODE_ENTRYPOINT alone (no CLAUDECODE) still counts', () => {
  expect(detectAgentLabel({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_CHILD_SESSION: '1' })).toBe(
    'subagent',
  );
});

test('Claude Code top-level session (no CLAUDE_CODE_CHILD_SESSION) has no auto label', () => {
  expect(detectAgentLabel({ CLAUDECODE: '1' })).toBe('');
  expect(detectAgentLabel({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('');
});

// --- Codex / opencode: no auto-detection today (see doc comment for why) ---
test('Codex env alone has no auto label — no child/parent signal exists to read', () => {
  expect(detectAgentLabel({ CODEX: '1' })).toBe('');
});

test('opencode env alone has no auto label — no child/parent signal exists to read', () => {
  expect(detectAgentLabel({ OPENCODE: '1' })).toBe('');
});

// --- Nothing at all ---
test('empty env has no auto label', () => {
  expect(detectAgentLabel({})).toBe('');
});

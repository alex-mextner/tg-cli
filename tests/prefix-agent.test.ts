import { expect, test } from 'bun:test';
import { buildPrefix } from '../features/render/prefix';
import { escapeHtml, toSansBold } from '../features/prefix-style/style';

// buildPrefix's `[agent]` bracket (tg#6254): unit coverage for the render
// shapes documented in the header comment of features/render/prefix.ts. No
// existing test file exercised buildPrefix directly before this — these also
// double as the base composition regression (no agentLabel → unchanged).
//
// A Latin agentLabel goes through the SAME styleWindowName styling as
// [window] (Sans-Serif Bold unicode) — expected strings below are built with
// toSansBold, exactly like tests/prefix-style.test.ts does for [window].

test('no aiEmoji/window/agent/tag/title → empty, not present', () => {
  const p = buildPrefix({ aiEmoji: '', model: '', tmuxWindow: '' });
  expect(p.present).toBe(false);
  expect(p.html).toBe('');
  expect(p.plain).toBe('');
});

test('agentLabel alone (no window/emoji) renders a bare [agent] bracket', () => {
  const p = buildPrefix({ aiEmoji: '', model: '', tmuxWindow: '', agentLabel: 'subagent' });
  expect(p.present).toBe(true);
  expect(p.plain).toBe(`[${toSansBold('subagent')}]\n`);
  expect(p.html).toBe(`[${toSansBold('subagent')}]\n`);
  expect(p.forceHtml).toBe(false);
});

test('window + agent: [window] [agent], space-separated, agent AFTER window', () => {
  const p = buildPrefix({ aiEmoji: '', model: '', tmuxWindow: 'api-bot', agentLabel: 'subagent' });
  expect(p.plain).toBe(`[${toSansBold('api-bot')}] [${toSansBold('subagent')}]\n`);
});

test('agent + tag + title all compose, in header order: [window] [agent] TAG — title', () => {
  const p = buildPrefix({
    aiEmoji: '',
    model: '',
    tmuxWindow: 'api-bot',
    agentLabel: 'subagent',
    tag: 'report',
    title: 'Ship it',
  });
  // Unicode fallback badge (no real pill ids configured in tests) + bold-italic title.
  expect(p.plain).toContain(`[${toSansBold('api-bot')}] [${toSansBold('subagent')}] `);
  expect(p.plain).toContain('🟢 REPORT');
  expect(p.plain).toContain(' — ');
});

test('a Cyrillic agent label falls back to <b> (same rule as [window]) and forces HTML', () => {
  const p = buildPrefix({ aiEmoji: '', model: '', tmuxWindow: '', agentLabel: 'фикс-агент' });
  expect(p.html).toBe('[<b>фикс-агент</b>]\n');
  expect(p.plain).toBe('[фикс-агент]\n');
  expect(p.forceHtml).toBe(true);
});

// Review finding: --agent has NO content restriction (unlike --tag's
// lowercase-english set), so an HTML-metacharacter label must come out
// escaped, not raw markup injection. styleWindowName already escapes both its
// branches (escapeHtml wraps the sans-bold unicode AND the <b> fallback) —
// this pins that guarantee for agent labels specifically, since it is now a
// free-form value supplied on every invocation, unlike a tmux window name.
test('an agent label with HTML metacharacters is escaped in the html branch, raw in plain', () => {
  const label = 'a<b>&c';
  const p = buildPrefix({ aiEmoji: '', model: '', tmuxWindow: '', agentLabel: label });
  const uni = toSansBold(label)!; // letters map, <, >, & stay literal (no foreign letter here)
  expect(p.html).toBe(`[${escapeHtml(uni)}]\n`); // & < > escaped to entities
  expect(p.html).toContain('&lt;');
  expect(p.html).toContain('&gt;');
  expect(p.html).toContain('&amp;');
  expect(p.plain).toBe(`[${uni}]\n`); // plain form stays raw — no escaping, no tags
});

test('an empty agentLabel renders no bracket at all (falsy string, not just undefined)', () => {
  const p = buildPrefix({ aiEmoji: '', model: '', tmuxWindow: 'api-bot', agentLabel: '' });
  expect(p.plain).toBe(`[${toSansBold('api-bot')}]\n`);
});

test('REGRESSION: no agentLabel behaves byte-identically to before this feature', () => {
  const withoutAgentKey = buildPrefix({ aiEmoji: '✳️', model: 'claude', tmuxWindow: 'api-bot', tag: 'answer' });
  const withUndefinedAgent = buildPrefix({
    aiEmoji: '✳️',
    model: 'claude',
    tmuxWindow: 'api-bot',
    agentLabel: undefined,
    tag: 'answer',
  });
  expect(withUndefinedAgent).toEqual(withoutAgentKey);
});

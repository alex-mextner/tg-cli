// Tier 1 of the escalation-format gate: the cheap, parse-time TAG_GATES check
// in features/cli/args.ts. For --tag decision|question with no literal table
// anywhere in the caption it is ADVISORY by default (WARN-mode): parseArgs
// attaches `escalationWarning` and STILL returns a `send` — it does NOT block.
// The entrypoint prints the warning and only hard-blocks under the off-by-
// default ESCALATION_GATE_ENFORCE flag (escalationGateEnforced). The more
// nuanced Tier 2 (the advisory pre-send-text hook) is covered in
// tests/hooks-escalation-format-gate.test.ts.
import { expect, test } from 'bun:test';
import { escalationGateEnforced, parseArgs } from '../features/cli/args';

const HOME = '/home/tester';
const CWD = '/tmp/no-such-cwd-for-tg-tests';

test('the "question" tag is accepted by --tag (parses, no validateTag rejection)', () => {
  const body = '| Option | Rec |\n| --- | --- |\n| A | go |';
  const r = parseArgs(['--tag', 'question', body], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.tag).toBe('question');
});

test('--tag decision with NO table is WARN (still a send), warning attached and names the actual tag', () => {
  const r = parseArgs(['--tag', 'decision', 'ship the thing or not?'], CWD, HOME);
  // WARN-mode default: it SENDS, it does not error.
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.escalationWarning).toBeDefined();
    // Names the ACTUAL tag used, not a hardcoded "decision/question" pair.
    expect(r.escalationWarning).toContain('--tag decision sends');
    expect(r.escalationWarning).toContain('| Option | Tradeoff | Recommendation |');
    // The mode-specific framing (advisory-proceeding vs blocked, and the
    // ESCALATION_GATE_ENFORCE mention) lives in the ENTRYPOINT, not here — the
    // parse-time message is core guidance only (see cli-subprocess.test.ts).
    expect(r.escalationWarning).not.toContain('ESCALATION_GATE_ENFORCE');
    expect(r.escalationWarning).not.toContain('proceeding');
  }
});

test('--tag question with NO table is WARN (still a send); message names "question", not "decision"', () => {
  const r = parseArgs(['--tag', 'question', 'which one do we ship?'], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.escalationWarning).toContain('--tag question sends');
    // "decision" the tag word must not leak into a question send's message
    // (the generic prose says "re-deriving the question", never "decision").
    expect(r.escalationWarning).not.toContain('decision');
  }
});

test('--tag decision WITH a markdown pipe table: no warning attached', () => {
  const body = ['| Option | Tradeoff |', '| --- | --- |', '| A | slower |'].join('\n');
  const r = parseArgs(['--tag', 'decision', body], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.escalationWarning).toBeUndefined();
});

test('--tag decision WITH --table (rows arrive on stdin, not argv): no warning attached', () => {
  const r = parseArgs(['--tag', 'decision', '--table'], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.escalationWarning).toBeUndefined();
});

test('--tag decision WITH an HTML <table> in the caption: no warning attached', () => {
  const r = parseArgs(['--tag', 'decision', '<table><tr><td>a</td></tr></table>'], CWD, HOME);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.escalationWarning).toBeUndefined();
});

test('non-escalation tags (problem/report) get no escalation warning', () => {
  for (const tag of ['problem', 'report']) {
    const r = parseArgs(['--tag', tag, 'plain prose, no table'], CWD, HOME);
    expect(r.action).toBe('send');
    if (r.action === 'send') expect(r.escalationWarning).toBeUndefined();
  }
});

test('the answer gate is a HARD block (severity block), unaffected by warn-mode', () => {
  const noReply = parseArgs(['--tag', 'answer', 'here is the answer'], CWD, HOME);
  expect(noReply.action).toBe('error');
  if (noReply.action === 'error') expect(noReply.message).toContain('--reply-to');

  const withReply = parseArgs(['--tag', 'answer', '--reply-to', '7', 'here is the answer'], CWD, HOME);
  expect(withReply.action).toBe('send');

  const terminal = parseArgs(['--tag', 'answer', '--terminal-question', 'here is the answer'], CWD, HOME);
  expect(terminal.action).toBe('send');
});

// --- ESCALATION_GATE_ENFORCE flag parse (the entrypoint upgrades an advisory
// warning to a hard block only when this is truthy) ---
test('escalationGateEnforced: truthy values enable enforcement', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
    expect(escalationGateEnforced({ ESCALATION_GATE_ENFORCE: v } as NodeJS.ProcessEnv)).toBe(true);
  }
});

test('escalationGateEnforced: absent / falsy values keep it OFF (warn-mode default)', () => {
  expect(escalationGateEnforced({} as NodeJS.ProcessEnv)).toBe(false);
  for (const v of ['', '0', 'false', 'no', 'off', 'nope']) {
    expect(escalationGateEnforced({ ESCALATION_GATE_ENFORCE: v } as NodeJS.ProcessEnv)).toBe(false);
  }
});

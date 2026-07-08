import { expect, test } from 'bun:test';
import { join } from 'path';

// Run the real `tg` script as a subprocess for the no-send actions/errors that
// resolve BEFORE the Telegram credential gate — so no API is ever touched and no
// creds are needed (mirrors the --version subprocess test in ergonomics.test.ts).

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');
const NO_CREDS_ENV = { PATH: process.env.PATH ?? '', HOME: '/tmp/tg-cli-test-home' };

function run(args: string[], stdin?: string) {
  return Bun.spawnSync(['bun', TG_SCRIPT, ...args], {
    env: NO_CREDS_ENV,
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
  });
}

test('tg help format prints the formatting reference and exits 0 (no creds needed)', () => {
  const proc = run(['help', 'format']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('Telegram message formatting');
  expect(out).toContain('--table');
  expect(out).toContain('&lt;');
  expect(out).toContain('<tg-emoji');
});

test('--format-help still works as a back-compat alias for `tg help format`', () => {
  // The flag is replaced by the topic-help convention but kept as an undocumented
  // alias so older scripts/skills that learned `--format-help` do not break.
  const flag = run(['--format-help']).stdout.toString();
  const topic = run(['help', 'format']).stdout.toString();
  expect(flag).toBe(topic);
  expect(flag).toContain('Telegram message formatting');
});

test('bare `tg help` prints the main help (lists the format topic) and exits 0', () => {
  const proc = run(['help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('Usage:');
  expect(out).toContain('tg help <topic>');
  expect(out).toContain('format');
});

test('`tg help <unknown>` errors with a 3-part message and exits non-zero', () => {
  const proc = run(['help', 'bogus']);
  expect(proc.exitCode).not.toBe(0);
  const err = proc.stderr.toString();
  expect(err).toContain("unknown help topic 'bogus'");
  expect(err).toContain('Available topics: format');
});

test('--help advertises `tg help format`, --table, --reply-to and --topic', () => {
  const proc = run(['--help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  // The canonical topic-help form is advertised (not a bespoke --format-help flag).
  expect(out).toContain('tg help format');
  expect(out).toContain('--table');
  expect(out).toContain('--reply-to');
  expect(out).toContain('--topic');
});

test('--help does NOT advertise the hidden terminal-only bypass flag', () => {
  // `--terminal-question` is the escape for the answer-requires-reply-to gate.
  // It must be discoverable ONLY from that gate's error message — never from
  // --help/usage. A normal user reading the help must not learn the escape.
  const out = run(['--help']).stdout.toString();
  expect(out).not.toContain('--terminal-question');
  expect(out).not.toContain('terminal-question');
  // Same for the `tg help` main-help surface.
  const helpMain = run(['help']).stdout.toString();
  expect(helpMain).not.toContain('terminal-question');
});

test('--help piped (non-TTY) is PLAIN — no ANSI color codes leak into the output', () => {
  // Color is gated on an interactive stdout; a captured subprocess pipe is not a
  // TTY, so the help must be plain text (no `\x1b[` escapes) even though an
  // interactive `tg --help` colorizes it.
  const proc = run(['--help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).not.toContain('\x1b[');
  // The advertised tags are lowercase-english only (anchor on stable tokens,
  // not the exact help wording).
  expect(out).toMatch(/lowercase[\s-]?english/i);
  expect(out).toContain('--tag');
  expect(out).toContain('answer');
});

test('--tag answer without --reply-to errors before the credential gate', () => {
  const proc = run(['--tag', 'answer', 'an answer']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  // The clear, non-misleading message — not an HTML-escaping artifact.
  expect(err).toContain('--tag answer must reply to a specific message');
  expect(err).toContain('--reply-to <message_id>');
  // The error — and ONLY the error — reveals the hidden terminal-only escape.
  expect(err).toContain('--terminal-question');
  expect(err).toContain('originated in the terminal');
  // It must NOT be the missing-credentials error — the parse error fires first.
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--terminal-question lets --tag answer pass the parse gate (reaches the credential gate)', () => {
  // With the bypass, the answer-without-reply-to parse error is GONE; the send
  // proceeds far enough to hit the missing-credentials gate (no creds in this
  // test env). The proof is the ABSENCE of the answer-gate error.
  const proc = run(['--tag', 'answer', '--terminal-question', 'a terminal answer']);
  const err = proc.stderr.toString();
  expect(err).not.toContain('--tag answer must reply to a specific message');
  // It got past parsing → it now fails on credentials, not on the answer gate.
  expect(err).toContain('TG_BOT_TOKEN');
});

test('--tag with an uppercase tag is rejected (lowercase-english only) before the credential gate', () => {
  const proc = run(['--tag', 'ANSWER', '--reply-to', '1', 'an answer']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain("invalid --tag 'ANSWER'");
  expect(err).toContain('lowercase english');
  expect(err).toContain('Use one of: answer, decision, problem, question, report');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--tag with a Cyrillic tag is rejected (lowercase-english only)', () => {
  const proc = run(['--tag', 'ОТВЕТ', 'a message']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain("invalid --tag 'ОТВЕТ'");
  expect(err).toContain('lowercase english');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--reply-to with a bad id errors before the credential gate', () => {
  const proc = run(['--reply-to', 'nope', 'x']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('positive message id');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--topic with a bad id errors before the credential gate', () => {
  const proc = run(['--topic', 'nope', 'x']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('positive topic id');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--topic without a value errors before the credential gate', () => {
  const proc = run(['--topic']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('--topic requires a topic id');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

// --- Tier-1 escalation-format gate: WARN-mode default vs ESCALATION_GATE_ENFORCE ---

function runWithEnv(args: string[], extraEnv: Record<string, string>) {
  return Bun.spawnSync(['bun', TG_SCRIPT, ...args], {
    env: { ...NO_CREDS_ENV, ...extraEnv },
  });
}

test('WARN-mode default: --tag decision with no table prints guidance but PROCEEDS past the escalation gate', () => {
  const proc = run(['--tag', 'decision', 'ship it or not?']);
  const err = proc.stderr.toString();
  // The core guidance is printed...
  expect(err).toContain('--tag decision sends');
  expect(err).toContain('| Option | Tradeoff | Recommendation |');
  // ...with the WARN-mode framing (advisory, sending anyway)...
  expect(err).toContain('Advisory only — sending anyway');
  // ...but it did NOT hard-stop at the escalation gate: it fell through to the
  // credential gate (no creds in this harness), proving the send proceeded.
  expect(err).toContain('TG_BOT_TOKEN');
  // And it was NOT the enforced hard-block (no contradictory "Blocked" line).
  expect(err).not.toContain('ESCALATION_GATE_ENFORCE is set');
  expect(err).not.toContain('Blocked:');
});

test('ESCALATION_GATE_ENFORCE=1: --tag decision with no table hard-blocks (exit 1) before the credential gate', () => {
  const proc = runWithEnv(['--tag', 'decision', 'ship it or not?'], { ESCALATION_GATE_ENFORCE: '1' });
  const err = proc.stderr.toString();
  expect(proc.exitCode).toBe(1);
  expect(err).toContain('--tag decision sends'); // the same core guidance
  expect(err).toContain('ESCALATION_GATE_ENFORCE is set'); // the hard-block reason
  // The contradictory WARN framing must NOT appear in enforce mode (review
  // finding): no "sending anyway", no "set the flag" (it's already set).
  expect(err).not.toContain('Advisory only — sending anyway');
  // Stopped at the escalation gate — never reached the credential gate.
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('ESCALATION_GATE_ENFORCE=1: --tag question (not just decision) also hard-blocks, naming "question"', () => {
  const proc = runWithEnv(['--tag', 'question', 'which option?'], { ESCALATION_GATE_ENFORCE: '1' });
  const err = proc.stderr.toString();
  expect(proc.exitCode).toBe(1);
  // The guidance names the ACTUAL tag used through the entrypoint path too.
  expect(err).toContain('--tag question sends');
  expect(err).toContain('ESCALATION_GATE_ENFORCE is set');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('ESCALATION_GATE_ENFORCE=1 WITH a table: no block, proceeds to the credential gate', () => {
  const body = '| Option | Tradeoff |\n| --- | --- |\n| A | slower |';
  const proc = runWithEnv(['--tag', 'decision', body], { ESCALATION_GATE_ENFORCE: '1' });
  const err = proc.stderr.toString();
  // A table is present, so the enforce flag has nothing to block: it falls
  // through to the credential gate (no creds here).
  expect(err).not.toContain('ESCALATION_GATE_ENFORCE is set');
  expect(err).toContain('TG_BOT_TOKEN');
});

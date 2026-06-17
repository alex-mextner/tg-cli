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

test('--help advertises `tg help format`, --table and --reply-to', () => {
  const proc = run(['--help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  // The canonical topic-help form is advertised (not a bespoke --format-help flag).
  expect(out).toContain('tg help format');
  expect(out).toContain('--table');
  expect(out).toContain('--reply-to');
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
  expect(err).toContain('--reply-to');
  // It must NOT be the missing-credentials error — the parse error fires first.
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--tag with an uppercase tag is rejected (lowercase-english only) before the credential gate', () => {
  const proc = run(['--tag', 'ANSWER', '--reply-to', '1', 'an answer']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain("invalid --tag 'ANSWER'");
  expect(err).toContain('lowercase english');
  expect(err).toContain('Use one of: answer, decision, problem, report');
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

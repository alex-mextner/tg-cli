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

test('--format-help prints the formatting reference and exits 0 (no creds needed)', () => {
  const proc = run(['--format-help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('Telegram message formatting');
  expect(out).toContain('--table');
  expect(out).toContain('&lt;');
  expect(out).toContain('<tg-emoji');
});

test('--help references --format-help, --table and --reply-to', () => {
  const proc = run(['--help']);
  const out = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(out).toContain('--format-help');
  expect(out).toContain('--table');
  expect(out).toContain('--reply-to');
});

test('--tag ANSWER without --reply-to errors before the credential gate', () => {
  const proc = run(['--tag', 'ANSWER', 'an answer']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('--reply-to');
  // It must NOT be the missing-credentials error — the parse error fires first.
  expect(err).not.toContain('TG_BOT_TOKEN');
});

test('--reply-to with a bad id errors before the credential gate', () => {
  const proc = run(['--reply-to', 'nope', 'x']);
  const err = proc.stderr.toString();
  expect(proc.exitCode).not.toBe(0);
  expect(err).toContain('positive message id');
  expect(err).not.toContain('TG_BOT_TOKEN');
});

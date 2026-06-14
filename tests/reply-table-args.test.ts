import { expect, test } from 'bun:test';
import { parseArgs } from '../features/cli/args';

const HOME = '/home/tester';
const CWD = '/tmp/no-such-cwd-for-tg-tests';

// --- --reply-to <message_id> ---

test('--reply-to sets replyTo to the numeric message id', () => {
  expect(parseArgs(['--reply-to', '1234', 'answer'], CWD, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'answer',
    format: 'plain',
    replyTo: 1234,
  });
});

test('a bare --reply-to (no body) still sends — it is not an empty invocation', () => {
  expect(parseArgs(['--reply-to', '7'], CWD, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '',
    format: 'plain',
    replyTo: 7,
  });
});

test('--reply-to requires a value', () => {
  expect(parseArgs(['--reply-to'], CWD, HOME)).toEqual({
    action: 'error',
    message: '--reply-to requires a message id',
  });
  expect(parseArgs(['--reply-to', '--tag', 'X'], CWD, HOME)).toEqual({
    action: 'error',
    message: '--reply-to requires a message id',
  });
});

test('--reply-to rejects a non-positive-integer id', () => {
  expect(parseArgs(['--reply-to', 'abc', 'x'], CWD, HOME)).toEqual({
    action: 'error',
    message: "--reply-to expects a positive message id, got 'abc'",
  });
  expect(parseArgs(['--reply-to', '0', 'x'], CWD, HOME)).toEqual({
    action: 'error',
    message: "--reply-to expects a positive message id, got '0'",
  });
  expect(parseArgs(['--reply-to', '12.5', 'x'], CWD, HOME)).toEqual({
    action: 'error',
    message: "--reply-to expects a positive message id, got '12.5'",
  });
});

// --- ANSWER tag REQUIRES --reply-to ---

test('--tag ANSWER without --reply-to is an actionable error', () => {
  const r = parseArgs(['--tag', 'ANSWER', 'here is the answer'], CWD, HOME);
  expect(r.action).toBe('error');
  if (r.action === 'error') {
    expect(r.message).toContain('--reply-to');
    expect(r.message).toContain('ANSWER');
  }
});

test('the Russian ОТВЕТ alias is gated identically (case-insensitive)', () => {
  expect(parseArgs(['--tag', 'ОТВЕТ', 'ответ'], CWD, HOME).action).toBe('error');
  expect(parseArgs(['--tag', 'answer', 'a'], CWD, HOME).action).toBe('error');
});

test('--tag ANSWER WITH --reply-to is accepted (the reply threads)', () => {
  expect(parseArgs(['--tag', 'ОТВЕТ', '--reply-to', '99', 'answer'], CWD, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'answer',
    format: 'plain',
    tag: 'ОТВЕТ',
    replyTo: 99,
  });
});

test('the OTHER tags do NOT require --reply-to', () => {
  for (const tag of ['DECISION', 'PROBLEM', 'REPORT', 'РЕШЕНИЕ', 'ПРОБЛЕМА', 'ОТЧЁТ']) {
    const r = parseArgs(['--tag', tag, 'body'], CWD, HOME);
    expect(r.action).toBe('send');
  }
});

test('an unknown tag is not subject to the ANSWER gate (still sends)', () => {
  const r = parseArgs(['--tag', 'WHATEVER', 'body'], CWD, HOME);
  expect(r.action).toBe('send');
});

// --- --table ---

test('--table sets the table flag (rows come from stdin, not argv)', () => {
  expect(parseArgs(['--table'], CWD, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '',
    format: 'plain',
    table: true,
  });
});

test('--table composes with --tag/--title and a heading', () => {
  expect(parseArgs(['--table', '--title', 'Status', 'heading text'], CWD, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'heading text',
    format: 'plain',
    title: 'Status',
    table: true,
  });
});

// --- --format-help action ---

test('--format-help resolves to the formatHelp action (wins anywhere)', () => {
  expect(parseArgs(['--format-help'], CWD, HOME)).toEqual({ action: 'formatHelp' });
  expect(parseArgs(['hi', '--format-help'], CWD, HOME)).toEqual({ action: 'formatHelp' });
});

// --- regression: a plain send still has no replyTo/table fields ---

test('a no-reply/no-table send is byte-identical to before (no extra fields)', () => {
  expect(parseArgs(['plain message'], CWD, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'plain message',
    format: 'plain',
  });
});

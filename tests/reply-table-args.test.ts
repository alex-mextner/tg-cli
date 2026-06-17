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

// --- the `answer` tag REQUIRES --reply-to ---

test('--tag answer without --reply-to is an actionable error', () => {
  const r = parseArgs(['--tag', 'answer', 'here is the answer'], CWD, HOME);
  expect(r.action).toBe('error');
  if (r.action === 'error') {
    expect(r.message).toContain('--reply-to');
    expect(r.message).toContain('answer');
  }
});

test('uppercase / Cyrillic tags are rejected at parse time, before the answer gate', () => {
  // These never reach the --reply-to gate: validateTag rejects them as not
  // lowercase-english first.
  for (const bad of ['ANSWER', 'ОТВЕТ']) {
    const r = parseArgs(['--tag', bad, 'a'], CWD, HOME);
    expect(r.action).toBe('error');
    if (r.action === 'error') {
      expect(r.message).toContain(`invalid --tag '${bad}'`);
      expect(r.message).toContain('lowercase english');
    }
  }
});

test('a PADDED answer tag is normalized and still gated on --reply-to', () => {
  // validateTag accepts surrounding whitespace; parseArgs trims it, so the
  // answer-gate (a literal `tag === 'answer'` compare) still fires.
  const r = parseArgs(['--tag', '  answer  ', 'here is the answer'], CWD, HOME);
  expect(r.action).toBe('error');
  if (r.action === 'error') expect(r.message).toContain('--reply-to');
  // With --reply-to it sends, and the stored tag is the trimmed canonical form.
  const ok = parseArgs(['--tag', '  answer  ', '--reply-to', '7', 'reply'], CWD, HOME);
  expect(ok.action).toBe('send');
  if (ok.action === 'send') expect(ok.tag).toBe('answer');
});

test('--tag answer WITH --reply-to is accepted (the reply threads)', () => {
  expect(parseArgs(['--tag', 'answer', '--reply-to', '99', 'a reply'], CWD, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'a reply',
    format: 'plain',
    tag: 'answer',
    replyTo: 99,
  });
});

test('the OTHER lowercase-english tags do NOT require --reply-to', () => {
  for (const tag of ['decision', 'problem', 'report']) {
    const r = parseArgs(['--tag', tag, 'body'], CWD, HOME);
    expect(r.action).toBe('send');
  }
});

test('an unknown tag is rejected (lowercase-english only) — never reaches the answer gate', () => {
  const r = parseArgs(['--tag', 'whatever', 'body'], CWD, HOME);
  expect(r.action).toBe('error');
  if (r.action === 'error') {
    expect(r.message).toContain("invalid --tag 'whatever'");
  }
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

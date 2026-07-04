import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Integration test for `tg-ctl harness-event` (tg-cli#113) against a fake Bot
// API. Proves: (1) a StopFailure payload with a parseable reset produces a
// notification WITH the auto-continue button; (2) the staleness guard suppresses
// a past-reset alert (the bug that leaked); (3) --dry-run sends NOTHING (test
// isolation — bug a); (4) the stalled reaction (😴) is set on the source message.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-harness-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

const sentMessages: any[] = [];
const reactions: any[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      sentMessages.push(await req.json());
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      reactions.push(await req.json());
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: true, result: {} });
  },
});

afterAll(() => server.stop(true));

async function runHarnessEvent(args: string[], stdin: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'harness-event', ...args], {
    env: { HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: `http://127.0.0.1:${server.port}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { code: proc.exitCode ?? 1, stdout };
}

function futureResetSeconds(minutes: number): number {
  return Math.floor((Date.now() + minutes * 60_000) / 1000);
}

function clearUsageWarningState(): void {
  const path = join(cfgDir, 'tg-ctl.123.usage-warnings.json');
  rmSync(path, { force: true });
  rmSync(`${path}.lock`, { force: true });
}

test('a session-limit with a parseable reset → notification + auto-continue button + stalled reaction', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    reason: 'session_limit',
    message: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)',
  });
  const { code } = await runHarnessEvent(['--agent', 'hyperide', '--pane', '%3', '--source-message-id', '55'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.chat_id).toBe(1);
  expect(msg.text).toContain('hyperide');
  expect(msg.text).toContain('session limit');
  // bug (c): no unrendered placeholder leaked into the live message.
  expect(msg.text).not.toMatch(/%\d/);
  // auto-continue button present, encoding pane + reset + source message id (55).
  const button = msg.reply_markup.inline_keyboard[0][0];
  expect(button.callback_data).toMatch(/^lc:%3:\d+:55$/);
  // stalled reaction (😴) on the source message.
  expect(reactions).toHaveLength(1);
  expect(reactions[0]).toMatchObject({ chat_id: 1, message_id: 55, reaction: [{ type: 'emoji', emoji: '😴' }] });
});

test('staleness guard: a past reset time emits NOTHING (no send, no reaction)', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const { code } = await runHarnessEvent(
    ['--reason', 'session_limit', '--reset-at', '2000-01-01T00:00:00Z', '--source-message-id', '55'],
    JSON.stringify({ message: 'limit' }),
  );
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('--dry-run sends nothing (isolation, bug a) and prints the rendered notification', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const { code, stdout } = await runHarnessEvent(
    ['--dry-run', '--agent', 'hyperide', '--pane', '%3', '--source-message-id', '55'],
    JSON.stringify({ reason: 'session_limit', message: 'resets 4:10am' }),
  );
  expect(code).toBe(0);
  expect(stdout).toContain('DRY-RUN');
  expect(stdout).toContain('[button]');
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('production path: a JSONL transcript_path (not flags) yields the reset + clean detail', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  // A realistic Claude transcript: per-line JSON with timestamps; the limit is the
  // last assistant message. This is the prod shape the bare hook feeds (no message
  // flag). Proves the reset is parsed from prose (not a line stamp) and the detail
  // is clean (not raw JSONL) — the two prod bugs the review caught.
  const transcript = join(cfgDir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2020-01-01T00:00:00.000Z' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)' }] },
      timestamp: '2026-07-02T10:00:00.000Z',
    }),
  ].join('\n');
  writeFileSync(transcript, lines);
  // stdin carries ONLY the hook envelope (reason + transcript_path), no message.
  const payload = JSON.stringify({ reason: 'session_limit', transcript_path: transcript });
  const { code } = await runHarnessEvent(['--agent', 'hyperide', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('session limit');
  // detail (blockquote) is clean prose — no raw JSON / timestamp leaked
  expect(msg.text).not.toContain('timestamp');
  expect(msg.text).not.toContain('"role"');
  // the button's reset came from the 4:10am prose, not the 2020 line stamp
  expect(msg.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^lc:%3:\d+$/);
});

test('transcript_path-only JSON payload is still treated as an explicit failure', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const transcript = join(cfgDir, 'transcript-only.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)' }] },
    }),
  );
  const { code } = await runHarnessEvent(['--agent', 'hyperide', '--pane', '%3'], JSON.stringify({ transcript_path: transcript }));
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('session limit');
  expect(msg.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^lc:%3:\d+$/);
  expect(reactions).toHaveLength(0);
});

test('an API error with no reset → alert, no button', async () => {
  sentMessages.length = 0;
  const { code } = await runHarnessEvent(['--agent', 'hyperide'], JSON.stringify({ reason: 'overloaded', message: 'overloaded_error (529)' }));
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('API error');
  expect(sentMessages[0].reply_markup).toBeUndefined();
});

test('JSON error field alone is treated as an explicit failure, not ignored telemetry', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const { code } = await runHarnessEvent(['--agent', 'hyperide'], JSON.stringify({ error: 'server_error (500)' }));
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('API error');
  expect(sentMessages[0].text).toContain('server_error');
  expect(sentMessages[0].reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

// PR #120 review: the REAL bare-hook payload uses `error_type`/`error`, not our
// test-only `reason`/`message` shape. Proves a live StopFailure hook (no
// --reason/--message flags, no `reason`/`message` fields on the payload) still
// classifies correctly and shows the real error text instead of "unknown".
test('production StopFailure shape (error_type/error, no reason/message) is read correctly', async () => {
  sentMessages.length = 0;
  // error_type deliberately does NOT contain "limit" (classifyFailure keys off
  // that substring) so this exercises the api-error path cleanly.
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'overloaded',
    error: 'The service is temporarily overloaded. Please retry.',
  });
  const { code } = await runHarnessEvent(['--agent', 'hyperide'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  // carries the REAL error_type matcher, not the "unknown" fallback the old
  // reason/matcher-only parser produced against this payload shape.
  expect(msg.text).toContain('API error');
  expect(msg.text).toContain('overloaded');
  expect(msg.text).not.toContain('unknown');
  // the real `error` string reached the detail blockquote, not a raw JSON dump.
  expect(msg.text).toContain('The service is temporarily overloaded. Please retry.');
  expect(msg.text).not.toContain('"error_type"');
});

// Review round 2 (Opus, PR #120): the api-error test above deliberately picked
// a non-"limit" error_type, which left the actual TARGET scenario of this PR
// series untested against the real field names — a rate-limit stop, where the
// reset time must be parsed out of `error` (not `message`) and the
// auto-continue button must still get built + armed. `rate_limit` is one of
// the documented StopFailure error_type values and (like the test/manual
// `session_limit` reason used elsewhere in this file) matches classifyFailure's
// /limit/i check, so it takes the session-limit branch exactly like a real hit
// would.
test('production StopFailure shape for an ACTUAL limit: button + button data + reset all resolve from error_type/error', async () => {
  sentMessages.length = 0;
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'rate_limit',
    error: 'You have hit your rate limit · resets 4:10am (Europe/Belgrade)',
  });
  const { code } = await runHarnessEvent(['--agent', 'hyperide', '--pane', '%3', '--source-message-id', '55'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('hyperide');
  expect(msg.text).not.toMatch(/%\d/); // no unrendered placeholder
  // resetAt was parsed out of the real `error` field text (not `message`,
  // which is absent from this payload) — the button is present and encodes it.
  expect(msg.reply_markup).toBeDefined();
  const button = msg.reply_markup.inline_keyboard[0][0];
  expect(button.callback_data).toMatch(/^lc:%3:\d+:55$/);
  expect(button.text).toContain('Auto-continue');
});

test('StopFailure payload wins over embedded usage telemetry and keeps auto-continue', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    session_id: 'abc123',
    hook_event_name: 'StopFailure',
    error_type: 'rate_limit',
    error: 'You have hit your rate limit · resets 4:10am (Europe/Belgrade)',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_at: futureResetSeconds(80) },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3', '--source-message-id', '55'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('hit its session limit');
  expect(msg.text).not.toContain('использовано');
  expect(msg.reply_markup).toBeDefined();
  expect(msg.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^lc:%3:\d+:55$/);
  expect(reactions[0]).toMatchObject({ chat_id: 1, message_id: 55, reaction: [{ type: 'emoji', emoji: '😴' }] });
});

test('stale StopFailure falls through to supported usage telemetry', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const staleReset = new Date(Date.now() - 60 * 60_000).toISOString();
  const payload = JSON.stringify({
    hook_event_name: 'StopFailure',
    error_type: 'rate_limit',
    error: 'You have hit your rate limit.',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300 },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3', '--reset-at', staleReset], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('is at');
  expect(sentMessages[0].text).toContain('91%');
  expect(sentMessages[0].reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('high usage payload at 90 percent sends a localized warning without auto-continue', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    agent: 'codex',
    user_language: 'ru',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: {
          used_percent: 91,
          window_minutes: 300,
          resets_at: futureResetSeconds(60),
        },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('codex');
  expect(msg.text).toContain('использовано');
  expect(msg.text).toContain('91%');
  expect(msg.text).toContain('5-часового лимита');
  expect(msg.reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('repeated identical high usage payload is deduped', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const reset = futureResetSeconds(90);
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_at: reset },
      },
    },
  });
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload)).code).toBe(0);
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload)).code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('91%');
  expect(reactions).toHaveLength(0);
});

test('repeated Codex relative-reset usage payload is deduped despite Date.now drift', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_in_seconds: 3600 },
      },
    },
  });
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload)).code).toBe(0);
  expect((await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload)).code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('91%');
  expect(reactions).toHaveLength(0);
});

test('concurrent identical high usage payloads claim the warning once', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_in_seconds: 3600 },
      },
    },
  });
  const results = await Promise.all([
    runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload),
    runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload),
  ]);
  expect(results.map((r) => r.code)).toEqual([0, 0]);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('91%');
  expect(reactions).toHaveLength(0);
});

test('usage --language flag overrides payload language hints', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    user_language: 'en',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_at: futureResetSeconds(100) },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3', '--language', 'ru'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('использовано');
  expect(sentMessages[0].text).toContain('91%');
  expect(sentMessages[0].reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('Claude statusLine usage with transcript_path is still treated as usage telemetry', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    hook_event_name: 'Status',
    session_id: 'abc123',
    transcript_path: '/tmp/nonexistent-claude-transcript.jsonl',
    user_language: 'ru',
    rate_limits: {
      five_hour: {
        used_percentage: 91,
        resets_at: futureResetSeconds(110),
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'claude', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0];
  expect(msg.text).toContain('использовано');
  expect(msg.text).toContain('91%');
  expect(msg.reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('Claude statusLine usage without hook_event_name is not misrouted by transcript_path alone', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    session_id: 'abc123',
    transcript_path: '/tmp/nonexistent-claude-transcript.jsonl',
    user_language: 'ru',
    rate_limits: {
      five_hour: {
        used_percentage: 91,
        resets_at: futureResetSeconds(115),
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'claude', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('использовано');
  expect(sentMessages[0].text).toContain('91%');
  expect(sentMessages[0].text).not.toContain('API error');
  expect(sentMessages[0].reply_markup).toBeUndefined();
  expect(reactions).toHaveLength(0);
});

test('usage payload with harmless top-level message remains usage, not unknown API error', async () => {
  clearUsageWarningState();
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    message: 'token telemetry sample',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, resets_at: futureResetSeconds(120) },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('is at');
  expect(sentMessages[0].text).not.toContain('API error');
});

test('unsupported telemetry with top-level message is ignored, not reported as unknown API error', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    message: 'token telemetry sample',
    type: 'message.updated',
    properties: { info: { providerID: 'opencode', tokens: { input: 120000, output: 10 } } },
  });
  const { code } = await runHarnessEvent(['--agent', 'opencode', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('usage payload below threshold is suppressed without falling back to unknown StopFailure', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 89, window_minutes: 300 },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

test('usage payload with stale reset is suppressed', async () => {
  sentMessages.length = 0;
  reactions.length = 0;
  const payload = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: {
          used_percent: 91,
          window_minutes: 300,
          resets_at: Math.floor((Date.now() - 60 * 60_000) / 1000),
        },
      },
    },
  });
  const { code } = await runHarnessEvent(['--agent', 'codex', '--pane', '%3'], payload);
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(0);
  expect(reactions).toHaveLength(0);
});

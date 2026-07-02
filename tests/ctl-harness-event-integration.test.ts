import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
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

test('an API error with no reset → alert, no button', async () => {
  sentMessages.length = 0;
  const { code } = await runHarnessEvent(['--agent', 'hyperide'], JSON.stringify({ reason: 'overloaded', message: 'overloaded_error (529)' }));
  expect(code).toBe(0);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0].text).toContain('API error');
  expect(sentMessages[0].reply_markup).toBeUndefined();
});

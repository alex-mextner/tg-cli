// Multi-question abandonment (tg#5741 review P1): when the ask client dies
// mid-collection (budget/timeout), the outstanding sub-question is retained for
// reconnect re-attach — but a LATE TAP on its card must be REFUSED, not
// late-delivered: the local multi-question dialog that took over may be showing
// a DIFFERENT question, so injecting the lone answer would answer the wrong
// prompt (all-or-nothing contract).
//
// Runs against a LOCAL fake Telegram server (Bun.serve, token `123:abc`,
// chat 1) — nothing ever reaches a real chat.
import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-multiq-abandon-'));
const tmuxLog = join(cfgDir, 'tmux-argv.log');
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
mkdirSync(join(cfgDir, 'bin'));
// The tmux stub LOGS its argv so the test can prove no send-keys injection ran.
writeFileSync(join(cfgDir, 'bin', 'tmux'), `#!/bin/sh\necho "$@" >> "${tmuxLog}"\nexit 0\n`, { mode: 0o755 });

const sentMessages: Array<{ message_id: number; text: string; callback_data: string }> = [];
const answeredCallbacks: Array<{ callback_query_id: string; text?: string }> = [];
const editedMessages: Array<{ message_id: number; text: string }> = [];
// Taps are pushed MANUALLY by the test (unlike the happy-path suite) so the
// client can be killed between the first answer and the second tap.
const tapQueue: Array<{ update_id: number; message_id: number; data: string }> = [];
let nextMessageId = 77;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const tap = tapQueue.shift();
      if (tap) {
        return Response.json({
          ok: true,
          result: [
            {
              update_id: tap.update_id,
              callback_query: {
                id: `cb${tap.update_id}`,
                from: { id: 1, first_name: 'Alex' },
                message: { message_id: tap.message_id, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) },
                data: tap.data,
              },
            },
          ],
        });
      }
      await Bun.sleep(100);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      const body = await req.json();
      const messageId = nextMessageId++;
      sentMessages.push({ message_id: messageId, text: body.text, callback_data: body.reply_markup.inline_keyboard[1][0].callback_data });
      return Response.json({ ok: true, result: { message_id: messageId } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      const body = await req.json();
      editedMessages.push({ message_id: body.message_id, text: body.text });
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/editMessageReplyMarkup')) {
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      answeredCallbacks.push(await req.json());
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const procs: Subprocess[] = [];

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  server.stop(true);
});

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await Bun.sleep(50);
  }
  return cond();
}

test('a late tap on an abandoned multi-question member is REFUSED, never injected', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(daemon);
  closeSync(logFd);

  const socket = join(cfgDir, 'tg-ctl.123.sock');
  expect(await waitFor(() => existsSync(socket), 5000)).toBe(true);

  // SCOPED ask (TMUX_PANE set): scoped members are the retained, late-deliverable
  // kind — exactly the case the refusal must cover.
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: {
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      TMUX_PANE: '%1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(ask);
  ask.stdin.write(
    JSON.stringify({
      session_id: 'abcdef123456',
      cwd: cfgDir,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { header: 'Deploy', question: 'Where should I deploy?', options: [{ label: 'Staging', description: 's' }, { label: 'Production', description: 'p' }] },
          { header: 'Timing', question: 'Deploy when?', options: [{ label: 'Now', description: 'n' }, { label: 'Tonight', description: 't' }] },
        ],
      },
    }) + '\n',
  );
  ask.stdin.end();

  // Card 1 posts → answer it → card 2 posts.
  expect(await waitFor(() => sentMessages.length === 1, 5000)).toBe(true);
  tapQueue.push({ update_id: 200, message_id: sentMessages[0].message_id, data: sentMessages[0].callback_data });
  expect(await waitFor(() => sentMessages.length === 2, 5000)).toBe(true);

  // The client dies mid-collection (its 115s budget elapsing, compressed to a
  // kill) → q2's socket closes → the daemon retains the member and marks the
  // card "answer all questions in the terminal".
  ask.kill(9);
  await ask.exited;
  const card2 = sentMessages[1].message_id;
  expect(
    await waitFor(() => editedMessages.some((e) => e.message_id === card2 && e.text.includes('answer all questions in the terminal')), 5000),
  ).toBe(true);

  // A LATE tap on the abandoned member: must answer "expired", retire the card,
  // and inject NOTHING into the pane.
  tapQueue.push({ update_id: 201, message_id: card2, data: sentMessages[1].callback_data });
  expect(await waitFor(() => answeredCallbacks.length === 2, 5000)).toBe(true);
  expect(answeredCallbacks[0]).toEqual({ callback_query_id: 'cb200', text: '✓ sent to the agent' });
  expect(answeredCallbacks[1]).toEqual({ callback_query_id: 'cb201', text: 'expired' });
  expect(
    await waitFor(() => editedMessages.some((e) => e.message_id === card2 && e.text === 'expired — answer in terminal'), 5000),
  ).toBe(true);
  // The refusal is logged, and no tmux injection ever ran for the lone answer.
  const daemonLog = readFileSync(join(cfgDir, 'daemon.log'), 'utf8');
  expect(daemonLog).toContain('ask-late-deliver-refused: multi-question member');
  const tmuxArgs = existsSync(tmuxLog) ? readFileSync(tmuxLog, 'utf8') : '';
  expect(tmuxArgs).not.toContain('send-keys');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 25_000);

import { afterAll, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';
import { serializeLimitsStore } from '../features/tg-ctl/limits';

// Limit-stop notify + scheduled auto-continue, end to end (tg-cli#113):
// a real daemon subprocess against a fake Bot API. The tmux shim prints an
// EMPTY pane list, so a fired auto-continue deterministically fails the
// verify-pane step — the "auto-continue failed" message IS the proof the timer
// fired and reached for the pane. Covers:
//   1. harness-limit socket line → card with the tgw button (+ dedupe)
//   2. button tap → schedule confirmed → timer fire (grace shrunk via env)
//   3. `tg-ctl harness-event` subprocess → transcript-tail classification → card
//   4. daemon down → harness-event degrades to a direct button-less send
//   5. restart: a persisted scheduled entry re-arms and fires

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

interface SentMessage {
  chat_id: number;
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

const sent: SentMessage[] = [];
const edited: { message_id: number; text: string }[] = [];
const callbackAnswers: { callback_query_id: string; text: string }[] = [];
// Updates handed to the daemon via getUpdates — appended mid-test (button taps).
const queue: Array<Record<string, unknown>> = [];
let sendSeq = 100;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/setMyCommands')) {
      await req.json();
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const pending = queue.filter((u) => (u.update_id as number) >= offset);
      if (pending.length) return Response.json({ ok: true, result: pending });
      await Bun.sleep(300);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push((await req.json()) as SentMessage);
      sendSeq += 1;
      return Response.json({ ok: true, result: { message_id: sendSeq } });
    }
    if (url.pathname.endsWith('/editMessageText')) {
      edited.push((await req.json()) as (typeof edited)[number]);
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/answerCallbackQuery')) {
      callbackAnswers.push((await req.json()) as (typeof callbackAnswers)[number]);
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/setMessageReaction') || url.pathname.endsWith('/editMessageReplyMarkup')) {
      await req.json();
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

function makeCfgDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tgctl-limit-'));
  writeFileSync(join(dir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(dir, 'config.yaml'), 'control:\n  enabled: true\n');
  // tmux PATH shim: empty pane list → every verify-pane fails (no real tmux touched).
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
  return dir;
}

function daemonEnv(cfgDir: string): Record<string, string> {
  return {
    PATH: `${join(cfgDir, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${server.port}`,
    TG_CTL_CONTINUE_GRACE_MS: '0',
  };
}

// One socket round-trip, like the hook client's oneAskAttempt.
function socketLine(cfgDir: string, line: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createConnection(join(cfgDir, 'tg-ctl.123.sock'));
    let raw = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk) => {
      raw += chunk;
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(raw.trim() || null);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function waitFor(pred: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await Bun.sleep(100);
  }
}

// ASYNC spawn (never spawnSync): the fake Bot API is served by THIS process's
// event loop — a spawnSync would block it and deadlock the child (directly, or
// through the daemon whose socket "ok" reply follows its own sendMessage).
async function runHarnessEvent(
  cfgDir: string,
  payload: Record<string, unknown>,
  pane: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn([TG_CTL, 'harness-event'], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, ...daemonEnv(cfgDir), TMUX_PANE: pane, TMUX: '' },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { exitCode, stdout };
}

const reg = createDaemonRegistry();

afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

test('limit-stop card → tap → scheduled timer fires; dedupe; harness-event client; restart re-arm', async () => {
  const cfgDir = makeCfgDir();
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env: daemonEnv(cfgDir), logFd });
  closeSync(logFd);

  // --- 1. harness-limit line → one card with the tgw schedule button ---
  // Far enough out that the tap lands BEFORE the reset → the schedule branch
  // arms a real timer (grace=0), which then fires within the test budget.
  const resetAt = Date.now() + 6000;
  const limitLine = JSON.stringify({
    kind: 'harness-limit',
    paneId: '%5',
    sessionName: 'rig',
    cwd: '/tmp/proj',
    failure: { kind: 'session-limit', text: "You've hit your session limit · resets 4:10am (Europe/Belgrade)", resetAt },
  });
  expect(await socketLine(cfgDir, limitLine)).toBe('ok');
  await waitFor(() => sent.some((m) => m.reply_markup !== undefined));
  const card = sent.find((m) => m.reply_markup !== undefined)!;
  expect(card.text).toContain('session limit');
  expect(card.text).toContain('rig');
  const button = card.reply_markup!.inline_keyboard[0][0];
  expect(button.callback_data.startsWith('tgw:')).toBe(true);
  expect(button.text.startsWith('продолжить в ')).toBe(true);

  // --- dedupe: same pane + same reset instant → no second card ---
  expect(await socketLine(cfgDir, limitLine)).toBe('ok');
  await Bun.sleep(400);
  expect(sent.filter((m) => m.reply_markup !== undefined).length).toBe(1);

  // --- 2. tap the button → schedule confirmed → timer fires (grace=0) ---
  queue.push({
    update_id: 500,
    callback_query: { id: 'cb1', from: { id: 1, first_name: 'Alex' }, message: { message_id: 101, chat: { id: 1 }, date: 0 }, data: button.callback_data },
  });
  await waitFor(() => callbackAnswers.length >= 1);
  expect(callbackAnswers[0].text.startsWith('scheduled at ')).toBe(true);
  // The card is re-rendered without its keyboard (one-shot button).
  await waitFor(() => edited.length >= 1);
  expect(edited[0].text).toContain('auto-continue scheduled at ');
  // The timer fires (resetAt + 0 grace); the empty-pane shim makes the inject
  // fail deterministically — the failure notice proves the fire reached for %5.
  await waitFor(() => sent.some((m) => m.text.includes('auto-continue failed')));
  const failure = sent.find((m) => m.text.includes('auto-continue failed'))!;
  expect(failure.text).toContain('%5');
  // A second tap on the consumed entry reads as expired.
  queue.push({
    update_id: 501,
    callback_query: { id: 'cb2', from: { id: 1, first_name: 'Alex' }, message: { message_id: 101, chat: { id: 1 }, date: 0 }, data: button.callback_data },
  });
  await waitFor(() => callbackAnswers.length >= 2);
  expect(callbackAnswers[1].text).toBe('expired');

  // --- 3. `tg-ctl harness-event` subprocess: transcript tail → card via daemon ---
  const transcript = join(cfgDir, 'transcript.jsonl');
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n` +
      `${JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your weekly limit · resets Jul 5 at 5am (Europe/Belgrade)" }] } })}\n`,
  );
  const before = sent.length;
  const hook = await runHarnessEvent(
    cfgDir,
    { hook_event_name: 'StopFailure', session_id: 's1', transcript_path: transcript, cwd: '/tmp/proj2' },
    '%7',
  );
  expect(hook.exitCode).toBe(0);
  expect(hook.stdout.trim()).toBe(''); // hooks must not print to stdout
  await waitFor(() => sent.length > before && sent.slice(before).some((m) => m.text.includes('weekly limit')));
  const weeklyCard = sent.slice(before).find((m) => m.text.includes('weekly limit'))!;
  expect(weeklyCard.reply_markup).toBeDefined(); // reset parsed from the transcript text

  // --- STALENESS guard: a limit whose reset already passed posts NO card ---
  const staleCount = sent.length;
  const staleLine = JSON.stringify({
    kind: 'harness-limit',
    paneId: '%8',
    failure: { kind: 'weekly-limit', text: 'stale weekly', resetAt: Date.now() - 60_000 },
  });
  expect(await socketLine(cfgDir, staleLine)).toBe('ok');
  await Bun.sleep(400);
  expect(sent.length).toBe(staleCount);

  // --- --dry-run renders the card without sending anything anywhere ---
  const dryBefore = sent.length;
  const dry = Bun.spawn([TG_CTL, 'harness-event', '--dry-run'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'StopFailure', transcript_path: transcript, cwd: '/tmp/proj2' }),
    ),
    env: { ...process.env, ...daemonEnv(cfgDir), TMUX_PANE: '%7', TMUX: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await dry.exited).toBe(0);
  const dryErr = await new Response(dry.stderr).text();
  expect(dryErr).toContain('dry-run card');
  expect(dryErr).toContain('weekly limit');
  await Bun.sleep(400);
  expect(sent.length).toBe(dryBefore); // nothing sent, no daemon card
}, 30_000);

test('harness-event with NO daemon degrades to a direct button-less notification', async () => {
  const cfgDir = makeCfgDir(); // no daemon spawned for this dir → no socket
  const transcript = join(cfgDir, 'transcript.jsonl');
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 2:20am (Europe/Belgrade)" }] } })}\n`,
  );
  const before = sent.length;
  const hook = await runHarnessEvent(
    cfgDir,
    { hook_event_name: 'StopFailure', transcript_path: transcript, cwd: '/tmp/x' },
    '%9',
  );
  expect(hook.exitCode).toBe(0);
  await waitFor(() => sent.length > before);
  const direct = sent[sent.length - 1];
  expect(direct.text).toContain('session limit');
  expect(direct.reply_markup).toBeUndefined(); // no daemon → no scheduler → no button
}, 15_000);

test('a persisted scheduled entry survives restart: re-armed and fired from disk', async () => {
  const cfgDir = makeCfgDir();
  // Pre-write the limits store as a previous daemon run would have left it.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.limits.json'),
    serializeLimitsStore({
      entries: [
        {
          token: 'restored1',
          paneId: '%3',
          sessionName: 'rig',
          cwd: '/tmp/proj',
          failureKind: 'session-limit',
          failureText: 'You have hit your session limit',
          resetAt: Date.now() - 1000, // already due → fires right after restore
          notifyMessageId: 55,
          scheduled: true,
          createdAt: Date.now() - 60_000,
        },
      ],
    }),
  );
  const before = sent.length;
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  await spawnDaemon(reg, { tgCtlPath: TG_CTL, cfgDir, env: daemonEnv(cfgDir), logFd });
  closeSync(logFd);
  await waitFor(() => sent.slice(before).some((m) => m.text.includes('auto-continue failed') && m.text.includes('%3')));
  expect(sent.slice(before).some((m) => m.text.includes('auto-continue failed') && m.text.includes('%3'))).toBe(true);
}, 20_000);

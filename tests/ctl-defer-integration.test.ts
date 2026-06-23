import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon, trackProc } from './helpers/daemon-lifecycle';

// End-to-end defer-while-waiting (spec tg#30): the real daemon, a fake Telegram
// server, and a fake tmux/ps that reports ONE claude pane (%1) and LOGS every
// injected payload. The danger under test: an inbound message that arrives while
// pane %1 has an OPEN question must NOT be pasted into that prompt — it is
// queued (✍️ reaction) and flushed only once the question is answered.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  // await stop: with active connections Bun returns a Promise; not awaiting it
  // leaks the listener into the next test (port/listener race).
  for (const s of servers.splice(0)) await s.stop(true);
});

const PANE_ID = '%1';
const PANE_PID = 4242;

// A fake tmux that: answers list-panes with one claude-hosting pane rooted at
// $TG_TEST_CWD; logs every send-keys -l / load-buffer payload to $TG_INJECT_LOG
// (one line per injected text) so the test can assert WHAT landed and WHEN; and
// exits 0 for everything else (Enter, paste-buffer, verify side-effects).
function fakeTmux(cwd: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    # Fields passed as %s args — the pane id is literally '%1', which must NOT
    # reach the printf FORMAT string (printf would read it as a directive).
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' 'main' '${cwd}'
    ;;
  display-message)
    printf 'main\\n'
    ;;
  send-keys)
    # Scan for the literal flag: 'send-keys -t %1 -l <text>' logs <text>. A bare
    # 'send-keys -t %1 Enter' (no -l) is the submit keystroke — never logged.
    while [ $# -gt 0 ]; do
      if [ "$1" = "-l" ]; then printf '%s\\n' "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer)
    # multi-line paste payload arrives on stdin
    cat >> '${injectLog}'
    printf '\\n' >> '${injectLog}'
    ;;
esac
exit 0
`;
}

// ps -axo pid=,ppid=,command= → the pane pid runs claude, so findAgentInPane
// resolves %1 to a claude agent.
function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${PANE_PID}' '1' 'claude'
exit 0
`;
}

function makeCfgDir(): string {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-defer-'));
  const injectLog = join(cfgDir, 'inject.log');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  // registration pins the target pane so discovery is deterministic.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: PANE_ID, cwd: cfgDir }),
  );
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return cfgDir;
}

function injected(cfgDir: string): string[] {
  const p = join(cfgDir, 'inject.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.length > 0);
}

// The daemon's stdout/stderr log (markers like the dead-letter / re-defer lines)
// — polled by tests to gate on an async handler having run, rather than sleeping
// a fixed time that a loaded CI runner can outrun.
function daemonLogText(cfgDir: string): string {
  const p = join(cfgDir, 'daemon.log');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

async function startDaemon(
  cfgDir: string,
  apiPort: number,
  extraEnv: Record<string, string> = {},
): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      // ONLY the fake bin dir on PATH for tmux/ps; node/bun resolve via execPath.
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
      ...extraEnv,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  return daemon;
}

function startAsk(
  cfgDir: string,
  apiPort: number,
  request: Record<string, unknown>,
  opts: { unscoped?: boolean } = {},
): Subprocess {
  const env: Record<string, string> = {
    PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
    HOME: cfgDir,
    TG_CTL_CONFIG_DIR: cfgDir,
    TG_API_BASE: `http://127.0.0.1:${apiPort}`,
  };
  // ask reads TMUX_PANE for the request's paneId; pin it to our pane — UNLESS we're
  // simulating the tg#30 case where the hook runs WITHOUT TMUX_PANE (paneId arrives
  // undefined and the daemon must resolve it via discovery).
  if (!opts.unscoped) env.TMUX_PANE = PANE_ID;
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const payload = opts.unscoped ? { cwd: cfgDir, ...request } : { cwd: cfgDir, paneId: PANE_ID, ...request };
  ask.stdin.write(JSON.stringify(payload) + '\n');
  ask.stdin.end();
  return ask;
}

test('inbound text deferred while a question is open, flushed (and not lost) after the answer', async () => {
  const cfgDir = makeCfgDir();

  // A scripted Telegram server. updateQueue feeds getUpdates one batch at a
  // time; the test drives the sequence by pushing updates between assertions.
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  let buttonMessageId = 0;
  let questionCallbackData = '';

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
          ?.inline_keyboard;
        if (kb?.length) {
          buttonMessageId += 1;
          questionCallbackData = kb[0][0].callback_data;
          return Response.json({ ok: true, result: { message_id: buttonMessageId } });
        }
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/answerCallbackQuery') || url.pathname.endsWith('/editMessageText')) {
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // 1) Open a question on pane %1 (hook → inline buttons). It blocks until the
  //    callback answers it.
  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_block',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  });
  trackProc(reg, ask);

  // Wait for the button message to be posted.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }

  // 2) TWO inbound texts arrive WHILE the question is open → both DEFERRED, in
  //    order. The second message tests both deferral AND that flush preserves
  //    FIFO across multiple queued items.
  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 10,
      message: {
        message_id: 11,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: nowSec,
        text: 'first thing',
      },
    },
  ]);
  // Wait for the first to be deferred (its ✍️ reaction) before sending the
  // second, so the daemon enqueues them in a deterministic order.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // nothing pasted into the open prompt
  expect(reactions.at(-1)).toMatchObject({ message_id: 11, reaction: [{ type: 'emoji', emoji: '✍️' }] });

  updateQueue.push([
    {
      update_id: 11,
      message: {
        message_id: 12,
        from: { id: 1, first_name: 'Alex' },
        chat: { id: 1 },
        date: nowSec,
        text: 'second thing',
      },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length < 2) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // still nothing pasted
  expect(reactions.at(-1)).toMatchObject({ message_id: 12, reaction: [{ type: 'emoji', emoji: '✍️' }] });

  // 3) Answer the question via the inline button → unblocks the agent → flush.
  //    The callback's source message_id must match the button message the daemon
  //    posted (captured above), else the daemon rejects a stale tap.
  updateQueue.push([
    {
      update_id: 12,
      callback_query: {
        id: 'cb1',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: buttonMessageId, chat: { id: 1 }, date: nowSec },
        data: questionCallbackData,
      },
    },
  ]);

  // ask resolves with the hook output once the callback lands.
  const askOut = await new Response(ask.stdout).text();
  await ask.exited;
  expect(askOut.length).toBeGreaterThan(0);

  // 4) Both deferred messages flush into the pane in FIFO order (flushDeferred
  //    sleeps 800ms before the first paste). Exactly two, first then second.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && injected(cfgDir).length < 2) await Bun.sleep(100);
  }
  const landed = injected(cfgDir);
  expect(landed).toHaveLength(2);
  expect(landed[0]).toContain('first thing');
  expect(landed[1]).toContain('second thing');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('a follow-up question ABANDONED mid-flush dead-letters its backlog instead of pasting it into the open prompt', async () => {
  // Regression for the codex P2 concurrent-flush race. Sequence:
  //   1. Q1 is answered → flushDeferred(%1) starts and sleeps 800ms (flushing).
  //   2. DURING that settle a follow-up Q2 opens on the SAME pane; an inbound
  //      message defers behind it (the pane is flushing AND has a pending
  //      question, so it queues — strict FIFO).
  //   3. Q2 is abandoned with NO Telegram answer (its hook socket closes). The
  //      pending button is deleted BEFORE onAbandon runs, so paneHasPendingQuestion
  //      is now false for it.
  //   4. The flush loop wakes. With the BUG, onQuestionAbandoned returned early
  //      purely on the flushingPanes guard (no dead-letter), and the loop — seeing
  //      no pending question — pasted the orphaned backlog into the still-open
  //      terminal prompt (the agent is still blocked locally on Q2). FIXED: the
  //      abandonment is recorded, the loop dead-letters the residual queue and
  //      warns the user; nothing is pasted.
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const plainMessages: string[] = []; // sendMessage bodies without inline buttons
  let buttonMessageId = 0;
  let questionCallbackData = '';

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
          ?.inline_keyboard;
        if (kb?.length) {
          buttonMessageId += 1;
          questionCallbackData = kb[0][0].callback_data;
          return Response.json({ ok: true, result: { message_id: buttonMessageId } });
        }
        plainMessages.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      // answerCallbackQuery / editMessageText
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // 1) Open Q1 and defer one message behind it so the flush has a backlog to
  //    drain when Q1 is answered (flushDeferred early-returns on an empty queue).
  const ask1 = startAsk(cfgDir, server.port, {
    requestId: 'q1',
    agent: 'claude',
    kind: 'question',
    question: 'First?',
    options: [{ label: 'Yes' }],
  });
  trackProc(reg, ask1);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }
  const q1Callback = questionCallbackData;
  const q1MessageId = buttonMessageId;

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 30,
      message: { message_id: 31, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q1 backlog' },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(reactions.at(-1)).toMatchObject({ message_id: 31, reaction: [{ type: 'emoji', emoji: '✍️' }] });
  expect(injected(cfgDir)).toEqual([]);

  // 2) Answer Q1 → flushDeferred(%1) starts and immediately sleeps 800ms. The
  //    flush is now IN FLIGHT (flushingPanes has %1) for the whole settle window.
  questionCallbackData = '';
  updateQueue.push([
    {
      update_id: 31,
      callback_query: {
        id: 'cbq1',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: q1MessageId, chat: { id: 1 }, date: nowSec },
        data: q1Callback,
      },
    },
  ]);
  await new Response(ask1.stdout).text();
  await ask1.exited;

  // 3) DURING the 800ms settle, a follow-up Q2 opens on the same pane.
  const ask2 = startAsk(cfgDir, server.port, {
    requestId: 'q2',
    agent: 'claude',
    kind: 'question',
    question: 'Second?',
    options: [{ label: 'Ok' }],
  });
  trackProc(reg, ask2);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }

  // ...and an inbound arrives behind Q2 (pane is flushing AND has a pending
  // question → it defers, strict FIFO).
  updateQueue.push([
    {
      update_id: 32,
      message: { message_id: 33, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q2 orphan' },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !reactions.some((r) => r.message_id === 33)) await Bun.sleep(50);
  }
  expect(reactions.find((r) => r.message_id === 33)).toMatchObject({ reaction: [{ type: 'emoji', emoji: '✍️' }] });

  // 4) Abandon Q2 with NO answer: kill its hook → socket close → onAbandon. The
  //    pending button is deleted first, so by the time the flush loop next checks,
  //    paneHasPendingQuestion(%1) is false. The FIX records the abandonment and the
  //    loop dead-letters the residual instead of pasting it.
  ask2.kill(9);
  await ask2.exited;

  // Wait for the flush to actually WAKE from its 800ms settle and reach a verdict,
  // racing the two mutually-exclusive outcomes rather than sleeping a fixed time
  // (a fixed sleep can pass vacuously if the buggy paste simply hasn't fired yet):
  //   - BUG  → the flush pastes 'q2 orphan' into the still-open prompt (it appears
  //            in the inject log), and no dead-letter notice is sent.
  //   - FIX  → the flush dead-letters the residual: nothing is pasted and the user
  //            gets the 'were NOT delivered' notice.
  // Poll until whichever lands first; the assertions below then decide pass/fail.
  // This fails FAST on the regression instead of hoping a fixed window covered it.
  const orphanPasted = (): boolean => injected(cfgDir).some((l) => l.includes('q2 orphan'));
  const deadLetterSent = (): boolean => plainMessages.some((m) => m.includes('were NOT delivered'));
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && !orphanPasted() && !deadLetterSent()) await Bun.sleep(50);
  }

  // THE REGRESSION: the orphaned 'q2 orphan' must NEVER reach the open prompt.
  // (With the bug it injects; fixed, it is dead-lettered.)
  expect(orphanPasted()).toBe(false);
  // Nothing at all should have been pasted — the pane's prompt is still open.
  expect(injected(cfgDir)).toEqual([]);
  // The flush woke and dead-lettered: the user was told the messages did not land.
  // (This is also the positive proof the flush ran — a no-op flush sends nothing.)
  expect(deadLetterSent()).toBe(true);

  // 5) The flag must not LEAK: a later, legitimate question on the same pane must
  //    still flush normally. If abandonedDuringFlush(%1) were left set, this next
  //    flush would wrongly dead-letter a valid backlog (the most dangerous failure
  //    mode of the new flag — silently dropping good messages). Open Q3, defer a
  //    message behind it, answer it, and assert the message actually lands.
  questionCallbackData = '';
  const ask3 = startAsk(cfgDir, server.port, {
    requestId: 'q3',
    agent: 'claude',
    kind: 'question',
    question: 'Third?',
    options: [{ label: 'Go' }],
  });
  trackProc(reg, ask3);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }
  const q3Callback = questionCallbackData;
  const q3MessageId = buttonMessageId;
  updateQueue.push([
    {
      update_id: 33,
      message: { message_id: 34, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q3 good' },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !reactions.some((r) => r.message_id === 34)) await Bun.sleep(50);
  }
  expect(reactions.find((r) => r.message_id === 34)).toMatchObject({ reaction: [{ type: 'emoji', emoji: '✍️' }] });
  updateQueue.push([
    {
      update_id: 34,
      callback_query: {
        id: 'cbq3',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: q3MessageId, chat: { id: 1 }, date: nowSec },
        data: q3Callback,
      },
    },
  ]);
  await new Response(ask3.stdout).text();
  await ask3.exited;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !injected(cfgDir).some((l) => l.includes('q3 good'))) await Bun.sleep(100);
  }
  // The legitimate Q3 backlog flushed (flag was cleared, not leaked).
  expect(injected(cfgDir).some((l) => l.includes('q3 good'))).toBe(true);
  // ...and the orphan still never resurfaced in this flush.
  expect(injected(cfgDir).some((l) => l.includes('q2 orphan'))).toBe(false);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('an abandonment racing a NEW live question re-defers (does not drop the live question backlog)', async () => {
  // Regression for review finding #1: the abandoned-during-flush flag is keyed by
  // PANE, but a pane can host a second LIVE question whose backlog must still be
  // delivered. Sequence:
  //   1. Q1 answered → flushDeferred(%1) starts, sleeps 800ms (flushing).
  //   2. During the settle Q2 opens; m2 defers behind it; Q2 is abandoned (flag set).
  //   3. ALSO during the settle Q3 opens (a real, still-pending question); m3 defers.
  //   4. The flush wakes: the flag is set, but Q3 is pending. It must RE-DEFER the
  //      residual (Q3's answer will flush it), NOT dead-letter it — dropping here
  //      would silently lose m3, a legitimately-queued message of a live question.
  //   5. Answer Q3 → m3 lands. (m2 rides along; per the per-pane design that is the
  //      accepted lesser evil vs. dropping the live question's message.)
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const plainMessages: string[] = [];
  let buttonMessageId = 0;
  let questionCallbackData = '';

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
          ?.inline_keyboard;
        if (kb?.length) {
          buttonMessageId += 1;
          questionCallbackData = kb[0][0].callback_data;
          return Response.json({ ok: true, result: { message_id: buttonMessageId } });
        }
        plainMessages.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  const waitForButton = async (): Promise<void> => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  };
  const waitForReaction = async (id: number): Promise<void> => {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !reactions.some((r) => r.message_id === id)) await Bun.sleep(50);
    expect(reactions.find((r) => r.message_id === id)).toMatchObject({ reaction: [{ type: 'emoji', emoji: '✍️' }] });
  };
  const nowSec = Math.floor(Date.now() / 1000);

  // Q1 + its backlog so the flush has work.
  const ask1 = startAsk(cfgDir, server.port, { requestId: 'q1', agent: 'claude', kind: 'question', question: 'First?', options: [{ label: 'Y' }] });
  trackProc(reg, ask1);
  await waitForButton();
  const q1Cb = questionCallbackData;
  const q1Msg = buttonMessageId;
  updateQueue.push([{ update_id: 40, message: { message_id: 41, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q1 backlog' } }]);
  await waitForReaction(41);

  // Answer Q1 → flush starts and sleeps 800ms.
  questionCallbackData = '';
  updateQueue.push([{ update_id: 41, callback_query: { id: 'c1', from: { id: 1, first_name: 'Alex' }, message: { message_id: q1Msg, chat: { id: 1 }, date: nowSec }, data: q1Cb } }]);
  await new Response(ask1.stdout).text();
  await ask1.exited;

  // During the settle: Q2 opens, m2 defers, Q2 abandoned.
  const ask2 = startAsk(cfgDir, server.port, { requestId: 'q2', agent: 'claude', kind: 'question', question: 'Second?', options: [{ label: 'Y' }] });
  trackProc(reg, ask2);
  await waitForButton();
  questionCallbackData = '';
  updateQueue.push([{ update_id: 42, message: { message_id: 43, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q2 orphan' } }]);
  await waitForReaction(43);

  // Q3 opens (a real, still-pending question) and m3 defers behind it — BEFORE we
  // abandon Q2, so the flush is guaranteed to see Q3 pending when it wakes.
  const ask3 = startAsk(cfgDir, server.port, { requestId: 'q3', agent: 'claude', kind: 'question', question: 'Third?', options: [{ label: 'Go' }] });
  trackProc(reg, ask3);
  await waitForButton();
  const q3Cb = questionCallbackData;
  const q3Msg = buttonMessageId;
  updateQueue.push([{ update_id: 43, message: { message_id: 44, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'q3 live' } }]);
  await waitForReaction(44);

  // Now abandon Q2 (socket close → flag set). The flush, on waking from its 800ms
  // settle, sees the flag AND Q3 pending → must re-defer, not dead-letter.
  ask2.kill(9);
  await ask2.exited;

  // Wait for the daemon to log the re-defer decision BEFORE answering Q3. This is
  // the deterministic proof the flush woke while Q3 was still pending and chose to
  // re-defer the residual (the finding-#1 behavior). Answering Q3 earlier could
  // race the 800ms settle and remove Q3 before the flush evaluates the gate.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !daemonLogText(cfgDir).includes('abandon raced a new question')) await Bun.sleep(50);
  }
  // The flush re-deferred (did NOT dead-letter) because a live question was pending.
  expect(daemonLogText(cfgDir)).toContain('abandon raced a new question');
  // ...and it must NOT have dropped the queue.
  expect(daemonLogText(cfgDir)).not.toContain('were NOT delivered');
  expect(daemonLogText(cfgDir)).not.toMatch(/dead-lettered \d+ queued message/);

  // Answer Q3 → its flush delivers m3 (the live question's message). The fix is
  // proven by m3 landing; with the bug (drop-everything) m3 would be lost.
  questionCallbackData = '';
  updateQueue.push([{ update_id: 44, callback_query: { id: 'c3', from: { id: 1, first_name: 'Alex' }, message: { message_id: q3Msg, chat: { id: 1 }, date: nowSec }, data: q3Cb } }]);
  await new Response(ask3.stdout).text();
  await ask3.exited;

  {
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && !injected(cfgDir).some((l) => l.includes('q3 live'))) await Bun.sleep(100);
  }
  // The live question's message was delivered, NOT dropped (review finding #1).
  expect(injected(cfgDir).some((l) => l.includes('q3 live'))).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('a question removed WITHOUT an answer (hook socket closes) does not wedge later inbound', async () => {
  // Regression for the review finding: extending defer to "queue non-empty" would
  // permanently wedge a pane once its question expired without a Telegram answer
  // (timeout / socket close / send failure delete the pending button but never
  // flush). After the question is gone, a NEW inbound must inject normally, not
  // sit deferred forever behind an undrainable backlog.
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  let buttonMessageId = 0;
  let questionCallbackData = '';

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
          ?.inline_keyboard;
        if (kb?.length) {
          buttonMessageId += 1;
          questionCallbackData = kb[0][0].callback_data;
          return Response.json({ ok: true, result: { message_id: buttonMessageId } });
        }
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      // answerCallbackQuery / editMessageText
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // Open a question; an inbound arrives and is deferred behind it.
  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_expire',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }],
  });
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([
    {
      update_id: 20,
      message: { message_id: 21, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'deferred one' },
    },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(reactions.at(-1)).toMatchObject({ message_id: 21, reaction: [{ type: 'emoji', emoji: '✍️' }] });
  expect(injected(cfgDir)).toEqual([]);

  // The question is removed WITHOUT an answer: kill the ask hook → its socket
  // closes → the daemon deletes the pending button AND dead-letters the pane's
  // backlog (so it can never resurface, stale + out of order, on a later
  // unrelated question's answer). The user is told the queued message did not land.
  questionCallbackData = '';
  ask.kill(9);
  await ask.exited;
  // Wait for the socket-close handler to actually run onAbandon (dead-letter the
  // idle pane) before sending the next inbound. Poll the daemon.log marker instead
  // of a fixed sleep: under a loaded CI runner a blind 300ms can fire the next
  // message before the abandon is processed, racing pending-question state.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !daemonLogText(cfgDir).includes('question abandoned on %1 (idle)')) {
      await Bun.sleep(50);
    }
    expect(daemonLogText(cfgDir)).toContain('question abandoned on %1 (idle)');
  }

  // A NEW inbound now arrives. With the bug it would be deferred (queue non-empty
  // → ✍️, stuck forever). Fixed: no pending question, no flush in flight → it
  // injects live and earns a 👀.
  updateQueue.push([
    {
      update_id: 21,
      message: { message_id: 22, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'after expiry' },
    },
  ]);
  // Wait for the new message to actually land in the pane (the real proof it was
  // NOT wedged). Injection runs verify-pane + paced send-keys, so allow time.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !injected(cfgDir).some((l) => l.includes('after expiry'))) {
      await Bun.sleep(100);
    }
  }
  // The new message landed; the abandoned 'deferred one' was dropped (not wedged).
  expect(injected(cfgDir)).toContain('[TG from Alex tg#22] after expiry');
  expect(injected(cfgDir).some((l) => l.includes('deferred one'))).toBe(false);
  // It was DELIVERED (👀), not deferred (✍️).
  {
    const t0 = Date.now();
    const got22 = (): Record<string, unknown> | undefined =>
      reactions.find((r) => r.message_id === 22);
    while (Date.now() - t0 < 4000 && !got22()) await Bun.sleep(50);
    expect(got22()).toMatchObject({ message_id: 22, reaction: [{ type: 'emoji', emoji: '👀' }] });
  }

  // The definitive regression (review P1): open a SECOND, unrelated question and
  // ANSWER it. The abandoned 'deferred one' from Q1 must NOT resurface in this
  // flush — it was dead-lettered, not left in the queue.
  const ask2 = startAsk(cfgDir, server.port, {
    requestId: 'q_second',
    agent: 'claude',
    kind: 'question',
    question: 'Second?',
    options: [{ label: 'Ok' }],
  });
  trackProc(reg, ask2);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }
  updateQueue.push([
    {
      update_id: 22,
      callback_query: {
        id: 'cb2',
        from: { id: 1, first_name: 'Alex' },
        message: { message_id: buttonMessageId, chat: { id: 1 }, date: nowSec },
        data: questionCallbackData,
      },
    },
  ]);
  await new Response(ask2.stdout).text();
  await ask2.exited;
  // Give a would-be stale flush ample time to (wrongly) fire, then assert it did not.
  await Bun.sleep(1500);
  expect(injected(cfgDir).some((l) => l.includes('deferred one'))).toBe(false);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// tg#30 regression: a question forwarded from a hook WITHOUT TMUX_PANE arrives with paneId
// undefined. Before the fix the defer guard (keyed on exact pane) never matched it, so inbound
// text was send-keys'd straight into the open prompt (fail OPEN). The daemon now resolves the
// pane via discovery (Layer 1) — and an unscoped question defers ANY pane as a backstop (Layer 2)
// — so the inbound is DEFERRED, not pasted into the prompt.
test('tg#30: an UNSCOPED question (hook had no TMUX_PANE) still DEFERS inbound, never pastes it', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  let questionCallbackData = '';

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
          ?.inline_keyboard;
        if (kb?.length) {
          questionCallbackData = kb[0][0].callback_data;
          return Response.json({ ok: true, result: { message_id: 1 } });
        }
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/answerCallbackQuery') || url.pathname.endsWith('/editMessageText')) {
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  servers.push(server);

  const daemon = await startDaemon(cfgDir, server.port);

  // Open a question with NO TMUX_PANE and NO paneId in the payload — the daemon must resolve the
  // pane itself (the registration + fake tmux both point at PANE_ID).
  const ask = startAsk(
    cfgDir,
    server.port,
    { requestId: 'q_unscoped', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] },
    { unscoped: true },
  );
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && questionCallbackData === '') await Bun.sleep(50);
    expect(questionCallbackData).not.toBe('');
  }

  // Inbound arrives WHILE the unscoped question is open → must be DEFERRED, not pasted.
  updateQueue.push([
    { update_id: 20, message: { message_id: 21, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'inject me' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // NOT send-keys'd into the open prompt (the fail-open bug)
  expect(reactions.at(-1)).toMatchObject({ message_id: 21, reaction: [{ type: 'emoji', emoji: '✍️' }] });

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

// --- "wait indefinitely" (#N): a SCOPED forwarded question must not expire on a timer ---
//
// The CTO's daily lifeline: a forwarded question whose pane is known (the normal,
// answerable case) must stay open until the human taps an answer in Telegram OR
// the agent process dies (socket close) — it must NEVER auto-expire to
// "expired — answer in terminal". The no-wedge guarantee is preserved by keeping
// the abandon timer for the UNSCOPED case only (an unscoped question defers ALL
// panes; a scoped one defers only its own pane, whose agent is itself blocked on
// this very question, so waiting forever there starves nothing).
//
// We shorten the unscoped bound to 1.5s via TG_CTL_UNSCOPED_TIMEOUT_MS so the
// tests exercise the expiry/no-expiry split without a real 110s wait; production
// never sets that env, so the bound stays 110s there.
const SHORT_UNSCOPED_MS = '1500';

// A Telegram server that records editMessageText bodies (so a test can assert the
// prompt was — or was NOT — rewritten to "expired"), tracks the question's
// callback data, and feeds getUpdates from a caller-owned queue.
function recordingServer(updateQueue: unknown[][], reactions: Array<Record<string, unknown>>, edits: string[]): {
  port: number;
  cb: () => string;
  stop: (closeActiveConnections?: boolean) => Promise<void> | void;
} {
  let questionCallbackData = '';
  let buttonMessageId = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const batch = updateQueue.shift();
        if (batch) return Response.json({ ok: true, result: batch });
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as Record<string, unknown>;
        const kb = (body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
          ?.inline_keyboard;
        if (kb?.length) {
          buttonMessageId += 1;
          questionCallbackData = kb[0][0].callback_data;
          return Response.json({ ok: true, result: { message_id: buttonMessageId } });
        }
        return Response.json({ ok: true, result: { message_id: 900 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/editMessageText')) {
        const body = (await req.json()) as Record<string, unknown>;
        edits.push(String(body.text ?? ''));
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { port: server.port, cb: () => questionCallbackData, stop: (c) => server.stop(c) };
}

test('a SCOPED question stays open PAST the abandon bound — no "expired", the callback still answers it, deferred inbound flushes', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits);
  servers.push(server);

  // 1.5s unscoped bound — if a SCOPED question were (wrongly) armed with it, it
  // would expire well within this test. It must not.
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: SHORT_UNSCOPED_MS });

  // Scoped question on %1 (startAsk pins TMUX_PANE=%1 by default).
  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_scoped_forever',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  });
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  // Inbound arrives while the question is open → DEFERRED (not pasted).
  updateQueue.push([
    { update_id: 30, message: { message_id: 31, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'queued while waiting' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]);
  expect(reactions.at(-1)).toMatchObject({ message_id: 31, reaction: [{ type: 'emoji', emoji: '✍️' }] });

  // Wait WELL past the (shortened) unscoped bound. A scoped question has NO timer,
  // so it must still be open: no "expired" edit, the ask subprocess still blocked,
  // the inbound still NOT pasted.
  await Bun.sleep(Number(SHORT_UNSCOPED_MS) + 1500);
  expect(edits).not.toContain('expired — answer in terminal');
  expect(ask.exitCode).toBeNull(); // ask is still blocked — the question never expired
  expect(injected(cfgDir)).toEqual([]); // nothing pasted into the still-open prompt

  // NOW the human answers via the inline button → the question resolves and the
  // deferred inbound flushes (proves the wait-forever path still reaches the
  // normal answer/flush machinery).
  updateQueue.push([
    { update_id: 31, callback_query: { id: 'cb1', from: { id: 1, first_name: 'Alex' }, message: { message_id: 1, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) }, data: server.cb() } },
  ]);
  const askOut = await new Response(ask.stdout).text();
  await ask.exited;
  expect(askOut.length).toBeGreaterThan(0); // the hook got its answer, not "expired"

  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && injected(cfgDir).length < 1) await Bun.sleep(100);
  }
  expect(injected(cfgDir)).toHaveLength(1);
  expect(injected(cfgDir)[0]).toContain('queued while waiting');
  expect(edits.at(-1)).toContain('answered'); // prompt rewritten to the answer, never "expired"

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('a SCOPED question that waits forever still cleans up on socket close (agent process dies) — backlog dead-lettered, pane freed', async () => {
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: SHORT_UNSCOPED_MS });

  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_scoped_diesocket',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }],
  });
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  // Queue an inbound behind the (scoped) open question.
  updateQueue.push([
    { update_id: 40, message: { message_id: 41, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'orphan me' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }

  // The agent process dies (hook socket closes) with NO Telegram answer. The
  // scoped question has no timer, so socket close is the ONLY cleanup path — it
  // must still fire: remove the entry and dead-letter the pane's backlog so a
  // later message on %1 is not wedged behind a ghost question.
  ask.kill(9);
  await ask.exited;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !daemonLogText(cfgDir).includes('dead-lettered')) await Bun.sleep(50);
  }
  expect(daemonLogText(cfgDir)).toContain('dead-lettered');
  expect(injected(cfgDir)).toEqual([]); // orphaned message NEVER pasted into the dead prompt

  // Pane is free again: a fresh inbound on %1 injects directly (no ghost defer).
  updateQueue.push([
    { update_id: 41, message: { message_id: 42, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'after the death' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && injected(cfgDir).length < 1) await Bun.sleep(100);
  }
  expect(injected(cfgDir)).toHaveLength(1);
  expect(injected(cfgDir)[0]).toContain('after the death');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('NO-WEDGE guard: an UNSCOPED question never answered still self-clears at the bound, freeing ALL-pane routing', async () => {
  // The safety invariant the timer protects. An unscoped question defers EVERY
  // pane (fail-closed Layer-2 match). If it could wait forever it would wedge
  // routing for the whole daemon. The bound MUST still fire for the unscoped case:
  // after it elapses the question is gone, the prompt is rewritten to "expired",
  // and inbound flows again. This is the mutation that would catch a regression
  // removing the unscoped bound (it would hang here, injected stays empty).
  const cfgDir = makeCfgDir();
  const updateQueue: unknown[][] = [];
  const reactions: Array<Record<string, unknown>> = [];
  const edits: string[] = [];
  const server = recordingServer(updateQueue, reactions, edits);
  servers.push(server);
  const daemon = await startDaemon(cfgDir, server.port, { TG_CTL_UNSCOPED_TIMEOUT_MS: SHORT_UNSCOPED_MS });

  // Unscoped question (hook had no TMUX_PANE) → defers ANY pane.
  const ask = startAsk(
    cfgDir,
    server.port,
    { requestId: 'q_unscoped_wedge', agent: 'claude', kind: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] },
    { unscoped: true },
  );
  trackProc(reg, ask);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && server.cb() === '') await Bun.sleep(50);
    expect(server.cb()).not.toBe('');
  }

  // Inbound arrives — deferred while the unscoped question is open (correct; the
  // tg#30 fail-closed backstop). It must NOT stay deferred forever.
  updateQueue.push([
    { update_id: 50, message: { message_id: 51, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'unwedge me' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && reactions.length === 0) await Bun.sleep(50);
  }
  expect(injected(cfgDir)).toEqual([]); // deferred for now (question still open)

  // NO answer is ever sent. The unscoped bound elapses → the question self-clears
  // (prompt → "expired"), the ask subprocess unblocks with null, and routing is
  // free again. A regression that drops the unscoped bound would never reach here.
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000 && !edits.includes('expired — answer in terminal')) await Bun.sleep(50);
  }
  expect(edits).toContain('expired — answer in terminal');
  await ask.exited; // the blocked hook is released (null) when its question expires

  // Routing un-wedged: a NEW inbound now injects directly (no ghost defer).
  updateQueue.push([
    { update_id: 51, message: { message_id: 52, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: Math.floor(Date.now() / 1000), text: 'routing alive' } },
  ]);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && injected(cfgDir).length < 1) await Bun.sleep(100);
  }
  expect(injected(cfgDir).some((l) => l.includes('routing alive'))).toBe(true);

  // Fate of the message deferred behind the EXPIRED unscoped question ('unwedge
  // me'): it is silently LOST. flushDeferred only fires on a real ANSWER, and an
  // unscoped expiry has no paneId to dead-letter, so the entry is dropped without
  // flushing OR dead-lettering its backlog; the later direct inject does not drain
  // it either. This is a deliberate, asserted DATA-LOSS gap (the user gets no
  // dead-letter notice), NOT mere "asymmetry" — distinct from the scoped
  // socket-close path which DOES dead-letter via onAbandon + notify. It is
  // PRE-EXISTING (the old 110s timer never dead-lettered an unscoped backlog —
  // onAbandon was gated on req.paneId) and tracked for a real fix in #58. Pinned
  // here so a future change can't silently regress it; the no-wedge guarantee —
  // the point of this test — holds regardless: 'routing alive' got through.
  expect(injected(cfgDir).some((l) => l.includes('unwedge me'))).toBe(false);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 40_000);

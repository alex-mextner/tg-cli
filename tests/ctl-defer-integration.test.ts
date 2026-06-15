import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

// End-to-end defer-while-waiting (spec tg#30): the real daemon, a fake Telegram
// server, and a fake tmux/ps that reports ONE claude pane (%1) and LOGS every
// injected payload. The danger under test: an inbound message that arrives while
// pane %1 has an OPEN question must NOT be pasted into that prompt — it is
// queued (✍️ reaction) and flushed only once the question is answered.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const procs: Subprocess[] = [];
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
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
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '${PANE_ID}' '${PANE_PID}' 'claude' '${cwd}'
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

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      // ONLY the fake bin dir on PATH for tmux/ps; node/bun resolve via execPath.
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  const socket = join(cfgDir, 'tg-ctl.123.sock');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !existsSync(socket)) await Bun.sleep(50);
  expect(existsSync(socket)).toBe(true);
  return daemon;
}

function startAsk(cfgDir: string, apiPort: number, request: Record<string, unknown>): Subprocess {
  const ask = Bun.spawn([process.execPath, TG_CTL, 'ask'], {
    env: {
      PATH: `${join(cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
      // ask reads TMUX_PANE for the request's paneId; pin it to our pane.
      TMUX_PANE: PANE_ID,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  ask.stdin.write(JSON.stringify({ cwd: cfgDir, paneId: PANE_ID, ...request }) + '\n');
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
  procs.push(daemon);

  // 1) Open a question on pane %1 (hook → inline buttons). It blocks until the
  //    callback answers it.
  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_block',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  });
  procs.push(ask);

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
  procs.push(daemon);

  // Open a question; an inbound arrives and is deferred behind it.
  const ask = startAsk(cfgDir, server.port, {
    requestId: 'q_expire',
    agent: 'claude',
    kind: 'question',
    question: 'Proceed?',
    options: [{ label: 'Yes' }],
  });
  procs.push(ask);
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
  await Bun.sleep(300); // let the socket-close handler run onAbandon

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
  expect(injected(cfgDir)).toContain('[TG from Alex #22] after expiry');
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
  procs.push(ask2);
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

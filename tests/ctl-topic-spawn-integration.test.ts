import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// End-to-end forum-topics SPAWN-ON-CREATE (docs/specs/tg-forum-topics.md §5, §9 increment 2):
// the real daemon, a fake Telegram server, and a fake tmux/ps. On `forum_topic_created` the
// daemon starts the /new flow (ask path → ask model via buttons → `tmux new-window` spawn →
// bind the returned pane). The fake tmux's `new-window` returns a pane id and LOGS its full
// argv so a test can assert the spawn shape (model argv, -c <path>, -n <slug>).
//
// The load-bearing guarantees (this is the CTO's daily lifeline daemon — none may regress):
//   1. A valid create → path → model-tap SPAWNS exactly one agent and binds the topic, with the
//      window name = the topic-name slug and the model's argv (`claude --model opus`).
//   2. A malformed path posts an error into the topic and does NOT spawn (no garbage agent).
//   3. A spawn FAILURE (tmux new-window exits non-zero) is caught: an error posts into the topic,
//      the binding stays awaiting-model (retryable), and the daemon keeps polling (next msg works).
//   4. A DUPLICATE forum_topic_created for an already-bound topic does NOT double-spawn.
//   5. With control.topics OFF, a forum_topic_created is ignored entirely — no binding, no spawn
//      (1:1 behaviour byte-identical).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActiveConnections?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

const SPAWNED_PANE = '%7'; // the pane id the fake tmux new-window returns

// A fake tmux that:
//  - list-panes: reports ONE pre-existing claude pane (%1, the flat default) so sessionForSpawn
//    has a session to target and discovery is happy.
//  - new-window: prints the SPAWNED_PANE id (the -P -F '#{pane_id}' contract) and logs the full
//    argv to $spawnLog so the test asserts the model argv + -c <path> + -n <slug>. When
//    $failSpawn exists it exits 1 (models a spawn failure) and prints an error to stderr.
//  - send-keys -l: logs '<pane>\t<text>' to $injectLog (a later message reaches the spawned pane).
function fakeTmux(cwd: string, spawnLog: string, injectLog: string, failFlag: string): string {
  return `#!/bin/sh
sub="$1"; shift
case "$sub" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '4241' 'claude' 'main' '${cwd}'
    ${''}# the spawned pane appears AFTER new-window ran (so a later inbound can route to it)
    if [ -f '${spawnLog}' ]; then
      printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '${SPAWNED_PANE}' '4277' 'claude' 'topicslug' '${cwd}'
    fi
    ;;
  display-message)
    printf 'main\\n'
    ;;
  new-window)
    if [ -f '${failFlag}' ]; then
      echo 'no current session' >&2
      exit 1
    fi
    printf 'new-window %s\\n' "$*" >> '${spawnLog}'
    printf '%s\\n' '${SPAWNED_PANE}'
    ;;
  send-keys)
    pane=''
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then printf '%s\\t%s\\n' "$pane" "$2" >> '${injectLog}'; break; fi
      shift
    done
    ;;
  load-buffer)
    cat >> '${injectLog}'
    printf '\\n' >> '${injectLog}'
    ;;
esac
exit 0
`;
}

function fakePs(): string {
  // Both the flat pane (4241) and the spawned pane (4277) run claude.
  return `#!/bin/sh
printf '%s %s %s\\n' '4241' '1' 'claude'
printf '%s %s %s\\n' '4277' '1' 'claude'
exit 0
`;
}

interface CfgPaths {
  cfgDir: string;
  spawnLog: string;
  injectLog: string;
  failFlag: string;
}

function makeCfgDir(opts: { topics: boolean; seedTopics?: unknown[] }): CfgPaths {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-spawn-'));
  const spawnLog = join(cfgDir, 'spawn.log');
  const injectLog = join(cfgDir, 'inject.log');
  const failFlag = join(cfgDir, 'FAIL_SPAWN');
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n  topics: ${opts.topics}\n`);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ paneId: '%1', cwd: cfgDir }));
  if (opts.seedTopics) writeFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), JSON.stringify(opts.seedTopics));
  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, spawnLog, injectLog, failFlag), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  return { cfgDir, spawnLog, injectLog, failFlag };
}

function topicsStore(cfgDir: string): Array<Record<string, unknown>> {
  const p = join(cfgDir, 'tg-ctl.123.topics.json');
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function spawnArgvLog(spawnLog: string): string[] {
  if (!existsSync(spawnLog)) return [];
  return readFileSync(spawnLog, 'utf8').split('\n').filter((l) => l.length > 0);
}

async function startDaemon(paths: CfgPaths, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(paths.cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir: paths.cfgDir,
    env: {
      PATH: `${join(paths.cfgDir, 'bin')}:/usr/bin:/bin`,
      HOME: paths.cfgDir,
      TG_CTL_CONFIG_DIR: paths.cfgDir,
      TG_API_BASE: `http://127.0.0.1:${apiPort}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(existsSync(join(paths.cfgDir, 'tg-ctl.123.sock'))).toBe(true);
  return daemon;
}

// A scripted Telegram server. updateQueue is drained one batch per getUpdates poll;
// sendMessage / answerCallbackQuery bodies are captured for assertions.
function makeServer(updateQueue: unknown[][]): {
  server: ReturnType<typeof Bun.serve>;
  sends: Array<Record<string, unknown>>;
  callbackAnswers: Array<Record<string, unknown>>;
} {
  const sends: Array<Record<string, unknown>> = [];
  const callbackAnswers: Array<Record<string, unknown>> = [];
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
        sends.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: { message_id: 900 + sends.length } });
      }
      if (url.pathname.endsWith('/answerCallbackQuery')) {
        callbackAnswers.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/setMessageReaction')) return Response.json({ ok: true, result: true });
      if (url.pathname.endsWith('/setMyCommands')) return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { server, sends, callbackAnswers };
}

function topicCreated(messageId: number, threadId: number, name: string, nowSec: number): unknown {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      message_thread_id: threadId,
      forum_topic_created: { name },
    },
  };
}

function topicTextMsg(messageId: number, threadId: number, text: string, nowSec: number): unknown {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      text,
      message_thread_id: threadId,
      is_topic_message: true,
    },
  };
}

function modelTap(updateId: number, threadId: number, modelId: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: 1, first_name: 'Alex' },
      message: { message_id: updateId, chat: { id: 1 }, date: 0 },
      data: `tgm:${threadId}:${modelId}`,
    },
  };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !pred()) await Bun.sleep(50);
}

test('topics ON: create → path → model tap SPAWNS one agent, binds the topic, window=slug, model argv', async () => {
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  // 1) topic created → daemon asks for the path
  updateQueue.push([topicCreated(20, 88, 'API bot', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 88 && t.status === 'awaiting-path'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 88)?.status).toBe('awaiting-path');

  // 2) user sends the working dir (cfgDir exists + is a dir) → advance to awaiting-model
  updateQueue.push([topicTextMsg(21, 88, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 88 && t.status === 'awaiting-model'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 88)?.path).toBe(cfgDir);

  // 3) user taps the Opus button → spawn + bind
  updateQueue.push([modelTap(22, 88, 'claude-opus')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 88 && t.status === 'bound'));

  const binding = topicsStore(cfgDir).find((t) => t.threadId === 88);
  expect(binding?.status).toBe('bound');
  expect(binding?.paneId).toBe(SPAWNED_PANE);
  expect(binding?.model).toBe('claude-opus');

  // The spawn ran exactly once, with the model argv, the topic-name slug, and -c <path>.
  const spawns = spawnArgvLog(paths.spawnLog);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]).toContain('claude --model opus');
  expect(spawns[0]).toContain('-c ' + cfgDir);
  expect(spawns[0]).toContain('-n api-bot'); // slugifyTopicName('API bot')

  // A confirmation posted into the topic (threaded).
  await waitFor(() => sends.some((s) => s.message_thread_id === 88 && String(s.text).includes('spawned')));
  expect(sends.some((s) => s.message_thread_id === 88 && String(s.text).includes('spawned'))).toBe(true);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a malformed path posts an error and does NOT spawn; daemon survives', async () => {
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(30, 90, 'broken', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 90 && t.status === 'awaiting-path'));

  // An absolute path that does not exist → re-asked, no advance, no spawn.
  updateQueue.push([topicTextMsg(31, 90, '/no/such/dir/at/all', nowSec + 1)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 90 && String(s.text).includes('existing directory')));
  expect(sends.some((s) => s.message_thread_id === 90 && String(s.text).includes('existing directory'))).toBe(true);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 90)?.status).toBe('awaiting-path'); // NOT advanced
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // nothing spawned

  // The daemon is still alive and polling — a valid path now advances it.
  updateQueue.push([topicTextMsg(32, 90, cfgDir, nowSec + 2)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 90 && t.status === 'awaiting-model'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 90)?.status).toBe('awaiting-model');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a spawn FAILURE is caught — error into the topic, binding stays awaiting-model, daemon keeps polling', async () => {
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  // Arm the spawn-failure flag: tmux new-window will exit 1.
  writeFileSync(paths.failFlag, '1');
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(40, 91, 'fails', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 91 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(41, 91, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 91 && t.status === 'awaiting-model'));

  // Tap a model → the spawn fails; the daemon must NOT crash.
  updateQueue.push([modelTap(42, 91, 'claude-opus')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 91 && String(s.text).includes("couldn't start")));
  expect(sends.some((s) => s.message_thread_id === 91 && String(s.text).includes("couldn't start"))).toBe(true);
  // The binding stays awaiting-model (retryable) — never half-bound.
  await Bun.sleep(200);
  const binding = topicsStore(cfgDir).find((t) => t.threadId === 91);
  expect(binding?.status).toBe('awaiting-model');
  expect(binding?.paneId).toBeUndefined();

  // CRITICAL: the daemon is still polling — a fresh topic-created is still handled.
  updateQueue.push([topicCreated(43, 92, 'survives', nowSec + 2)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 92 && t.status === 'awaiting-path'));
  expect(topicsStore(cfgDir).find((t) => t.threadId === 92)?.status).toBe('awaiting-path');

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a DUPLICATE forum_topic_created for an already-bound topic does NOT double-spawn', async () => {
  // Seed the topic ALREADY bound, then send a duplicate create. stepUpdates filters it
  // (bound → no topic-new), so the entrypoint never re-spawns and the live pane is kept.
  const paths = makeCfgDir({
    topics: true,
    seedTopics: [{ threadId: 93, name: 'api', status: 'bound', paneId: SPAWNED_PANE, ts: 1 }],
  });
  const { cfgDir } = paths;
  // The spawn log must show the pane as live for list-panes, so pre-create it empty? No —
  // a bound seed needs no spawn log. Touch it so the fake tmux reports the spawned pane.
  writeFileSync(paths.spawnLog, '');
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(50, 93, 'api', nowSec)]);
  // Give the daemon time to process the (ignored) duplicate.
  await Bun.sleep(600);

  // Still bound to the SAME pane; no new-window argv was logged (spawn log unchanged/empty).
  const binding = topicsStore(cfgDir).find((t) => t.threadId === 93);
  expect(binding?.status).toBe('bound');
  expect(binding?.paneId).toBe(SPAWNED_PANE);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // no new-window ran

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

function injected(injectLog: string): Array<{ pane: string; text: string }> {
  if (!existsSync(injectLog)) return [];
  return readFileSync(injectLog, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const tab = l.indexOf('\t');
      return tab === -1 ? { pane: '', text: l } : { pane: l.slice(0, tab), text: l.slice(tab + 1) };
    });
}

test('topics ON: a DUPLICATE model tap does NOT double-spawn — second tap gets "already running", one new-window', async () => {
  // The central code claim ("a late/duplicate tap can't launch a second agent"). Drive the real
  // flow to bound, then tap the model button AGAIN: the bound-guard must refuse it with no spawn.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends, callbackAnswers } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(70, 95, 'dup', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 95 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(71, 95, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 95 && t.status === 'awaiting-model'));
  updateQueue.push([modelTap(72, 95, 'claude-opus')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 95 && t.status === 'bound'));
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1); // one spawn so far
  const sendsAfterBind = sends.length;

  // The DUPLICATE tap (e.g. the human taps twice, or a stale message) → refused, no second spawn.
  // The bound-guard answers ONLY the transient callback toast — NOT a fresh topic message — so a
  // multi-tap can't flood the topic.
  updateQueue.push([modelTap(73, 95, 'claude-opus')]);
  await waitFor(() => callbackAnswers.some((c) => String(c.text).includes('already running')));
  expect(callbackAnswers.some((c) => String(c.text).includes('already running'))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1); // STILL one — no double-spawn
  expect(topicsStore(cfgDir).find((t) => t.threadId === 95)?.paneId).toBe(SPAWNED_PANE); // same pane
  expect(sends.length).toBe(sendsAfterBind); // no extra topic message — toast only, no spam

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: spawn → bind → ROUTE — a follow-up message in the topic reaches the spawned pane', async () => {
  // The end-to-end seam: after a spawn binds %7, a normal topic message must inject into %7 (the
  // new agent), NOT the flat %1. Proves spawn-on-create ties into the #54 per-topic routing.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(80, 96, 'route', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 96 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(81, 96, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 96 && t.status === 'awaiting-model'));
  updateQueue.push([modelTap(82, 96, 'claude-default')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 96 && t.status === 'bound'));

  // Now a real message inside the topic → must route to the SPAWNED pane (%7).
  updateQueue.push([topicTextMsg(83, 96, 'hello new agent', nowSec + 2)]);
  await waitFor(() => injected(paths.injectLog).some((i) => i.pane === SPAWNED_PANE));
  const landed = injected(paths.injectLog).filter((i) => i.text.includes('hello new agent'));
  expect(landed).toHaveLength(1);
  expect(landed[0].pane).toBe(SPAWNED_PANE); // the spawned agent, NOT the flat %1
  expect(landed[0].text).toContain('[TG from Alex'); // wrapped like a normal inbound

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics OFF: a forum_topic_created is ignored — no binding, no spawn (1:1 unchanged)', async () => {
  const paths = makeCfgDir({ topics: false });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(60, 94, 'ignored', nowSec)]);
  await Bun.sleep(600);

  // No topic store written, nothing spawned — the flag-off path never touches topics.
  expect(existsSync(join(cfgDir, 'tg-ctl.123.topics.json'))).toBe(false);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a FORGED/unknown modelId tap on an awaiting-model topic → "unknown model", no spawn, binding intact', async () => {
  // The only real path to handleTopicModel's unknown-model guard is a stale/forged callback (the
  // keyboard emits only valid ids). Drive to awaiting-model, then tap a bogus model id.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(100, 97, 'forged', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 97 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(101, 97, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 97 && t.status === 'awaiting-model'));

  updateQueue.push([modelTap(102, 97, 'bogus-model')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 97 && String(s.text).includes('unknown model')));
  expect(sends.some((s) => s.message_thread_id === 97 && String(s.text).includes('unknown model'))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // nothing spawned
  // The binding stays awaiting-model with NO model recorded (a bad id never persisted) — retryable.
  const binding = topicsStore(cfgDir).find((t) => t.threadId === 97);
  expect(binding?.status).toBe('awaiting-model');
  expect(binding?.model).toBeUndefined();

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a model tap with NO binding → "not in setup", no spawn', async () => {
  // A stale tgm: tap into a topic the daemon has no binding for (e.g. created before the bot, or
  // the store was reset). Must refuse cleanly, never spawn.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  updateQueue.push([modelTap(110, 98, 'claude-opus')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 98 && String(s.text).includes("isn't in setup")));
  expect(sends.some((s) => s.message_thread_id === 98 && String(s.text).includes("isn't in setup"))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 98)).toBeUndefined();

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a RELATIVE path is rejected (validation vs tmux -c resolve against different cwds)', async () => {
  // statSync resolves a relative path against the daemon cwd; tmux -c resolves it against the tmux
  // server cwd. They can differ → an absolute path is required so both see the same dir.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(130, 101, 'rel', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 101 && t.status === 'awaiting-path'));
  // `bin` exists under cfgDir (a relative path would resolve there from the daemon cwd) — but it
  // is not absolute, so it must be rejected regardless.
  updateQueue.push([topicTextMsg(131, 101, 'bin', nowSec + 1)]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 101 && String(s.text).includes('absolute path')));
  expect(sends.some((s) => s.message_thread_id === 101 && String(s.text).includes('absolute path'))).toBe(true);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 101)?.status).toBe('awaiting-path'); // not advanced
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a TEXT message in awaiting-model re-shows the model buttons, does not spawn', async () => {
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(140, 102, 'retext', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 102 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(141, 102, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 102 && t.status === 'awaiting-model'));
  const sendsBefore = sends.length;

  // Stray prose instead of a button tap → the daemon re-posts the model prompt (with buttons).
  updateQueue.push([topicTextMsg(142, 102, 'opus please', nowSec + 2)]);
  await waitFor(
    () =>
      sends.length > sendsBefore &&
      sends.some((s) => s.message_thread_id === 102 && (s.reply_markup as Record<string, unknown> | undefined) !== undefined),
  );
  expect(sends.some((s) => s.message_thread_id === 102 && (s.reply_markup as Record<string, unknown> | undefined) !== undefined)).toBe(true);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 102)?.status).toBe('awaiting-model'); // unchanged
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]); // prose never spawns

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: TWO model taps in ONE getUpdates batch spawn EXACTLY one agent (sequential dispatch invariant)', async () => {
  // The no-double-spawn guarantee depends on strictly sequential action dispatch: the first tap
  // reaches `bound` before the second's bound-guard reads the store. Both taps arrive in one batch.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(150, 103, 'batch', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 103 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(151, 103, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 103 && t.status === 'awaiting-model'));

  // Both taps in the SAME batch.
  updateQueue.push([modelTap(152, 103, 'claude-opus'), modelTap(153, 103, 'claude-opus')]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 103 && t.status === 'bound'));
  await Bun.sleep(300);
  // Exactly one new-window ran despite two taps in one batch.
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 103)?.paneId).toBe(SPAWNED_PANE);

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a model tap in awaiting-PATH (no dir yet) → "send the working directory first", no spawn', async () => {
  // A tap before the path is supplied (status awaiting-path) hits the wrong-state guard.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server, sends } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(120, 99, 'nopath', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 99 && t.status === 'awaiting-path'));

  updateQueue.push([modelTap(121, 99, 'claude-opus')]);
  await waitFor(() => sends.some((s) => s.message_thread_id === 99 && String(s.text).includes('working directory first')));
  expect(sends.some((s) => s.message_thread_id === 99 && String(s.text).includes('working directory first'))).toBe(true);
  await Bun.sleep(200);
  expect(spawnArgvLog(paths.spawnLog)).toEqual([]);
  expect(topicsStore(cfgDir).find((t) => t.threadId === 99)?.status).toBe('awaiting-path'); // unchanged

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

test('topics ON: a model tap + a text message in ONE batch does NOT strand the bound pane (stale topic-answer race)', async () => {
  // codex P2 race: in awaiting-model, a model tap (-> topic-model) and a text message
  // (-> topic-answer) can land in the SAME getUpdates batch. topic-model runs first -> bound;
  // the stale topic-answer then reloads a BOUND binding. Without the awaiting-path guard,
  // applyPathAnswer would move the bound topic BACK to awaiting-model and strand the spawned
  // pane. The guard must drop the stale answer: the topic stays bound, pane intact.
  const paths = makeCfgDir({ topics: true });
  const { cfgDir } = paths;
  const updateQueue: unknown[][] = [];
  const { server } = makeServer(updateQueue);
  servers.push(server);
  const daemon = await startDaemon(paths, server.port);

  const nowSec = Math.floor(Date.now() / 1000);
  updateQueue.push([topicCreated(160, 104, 'race', nowSec)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 104 && t.status === 'awaiting-path'));
  updateQueue.push([topicTextMsg(161, 104, cfgDir, nowSec + 1)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 104 && t.status === 'awaiting-model'));

  // The model tap AND a text message (a valid absolute existing dir — the dangerous case) in ONE
  // batch. The tap binds; the stale answer must be ignored, NOT reset the binding.
  updateQueue.push([modelTap(162, 104, 'claude-opus'), topicTextMsg(163, 104, cfgDir, nowSec + 2)]);
  await waitFor(() => topicsStore(cfgDir).some((t) => t.threadId === 104 && t.status === 'bound'));
  await Bun.sleep(300);

  const binding = topicsStore(cfgDir).find((t) => t.threadId === 104);
  expect(binding?.status).toBe('bound'); // NOT reset to awaiting-model
  expect(binding?.paneId).toBe(SPAWNED_PANE); // pane preserved, not stranded
  expect(spawnArgvLog(paths.spawnLog)).toHaveLength(1); // exactly one spawn

  daemon.kill('SIGTERM');
  await daemon.exited;
}, 30_000);

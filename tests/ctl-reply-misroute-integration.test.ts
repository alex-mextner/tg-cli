import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

// Regression for issue #53: with TWO agents running, a reply to agent-B's (%5)
// message was mis-delivered to agent-A (%2). Root cause: a RECOGNIZED reply
// route (origin pane known from routes.json) lost to the live-pane check when
// the launchd `tmux list-panes` flake returned an EMPTY/partial snapshot — it
// fell through and silently injected into whatever single agent was visible
// (deterministically the registration's last writer, %2).
//
// This drives the REAL daemon against a fake Telegram + a fake tmux/ps whose
// pane visibility is switchable via a "mode" file, so we can simulate both the
// healthy snapshot (origin %5 visible → inject there) and the flake (snapshot
// empty → MUST post the picker, never inject into %2).

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

// Two agents. %5 = the [3d] agent (the reply's ORIGIN); %2 = the [rig] agent
// (the registration's last writer — the WRONG pane the bug delivered to).
const PANE_3D = '%5';
const PID_3D = 5005;
const PANE_RIG = '%2';
const PID_RIG = 2002;

const procs: Subprocess[] = [];
const servers: Array<{ stop: (c?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  for (const s of servers.splice(0)) await s.stop(true);
});

// tmux shim: pane visibility depends on the contents of <cfgDir>/tmux-mode.
//   "normal"  → list-panes returns BOTH agent panes (origin %5 visible)
//   "empty"   → list-panes returns NOTHING (the launchd flake)
// Every `send-keys -t <pane> -l <text>` is logged as "<pane>\t<text>" so the
// test can assert WHICH pane received the inject. display-message answers the
// per-pane path query (recordRoute / windowName), keyed off the pane arg.
function fakeTmux(cfgDir: string, dir3d: string, dirRig: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
mode=$(cat '${join(cfgDir, 'tmux-mode')}' 2>/dev/null || echo normal)
case "$sub" in
  list-panes)
    # window_name variant (#{pane_id}\\t#{window_name}) used by listAgentCandidates
    name_format=0
    for a in "$@"; do case "$a" in *window_name*) name_format=1;; esac; done
    # "empty"   → no panes at all (the full launchd flake)
    # "partial" → ONLY %2 visible (origin %5 missing — the realistic misroute:
    #             the recognition snapshot can't confirm %5, but a later snapshot
    #             shows just the registration's last writer %2)
    # "normal"  → both agent panes visible
    if [ "$mode" = "empty" ]; then exit 0; fi
    if [ "$name_format" = "1" ]; then
      [ "$mode" = "partial" ] || printf '%s\\t%s\\n' '${PANE_3D}' '3d'
      printf '%s\\t%s\\n' '${PANE_RIG}' 'rig'
    else
      [ "$mode" = "partial" ] || printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 's3d' '0' '${PANE_3D}' '${PID_3D}' 'claude' '${dir3d}'
      printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'srig' '0' '${PANE_RIG}' '${PID_RIG}' 'claude' '${dirRig}'
    fi
    ;;
  display-message)
    # -t <pane> ... #{pane_current_path}: echo that pane's path.
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    if [ "$pane" = "${PANE_3D}" ]; then printf '%s\\n' '${dir3d}'
    elif [ "$pane" = "${PANE_RIG}" ]; then printf '%s\\n' '${dirRig}'
    else printf 'main\\n'; fi
    ;;
  send-keys)
    # Skip a bare Enter (the submit keystroke). Log the destination pane for any
    # literal text inject so the test can assert WHICH pane received it.
    pane=""; text=""; is_enter=0
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then pane="$2"; fi
      if [ "$1" = "-l" ]; then text="$2"; fi
      if [ "$1" = "Enter" ]; then is_enter=1; fi
      shift
    done
    if [ "$is_enter" = "0" ] && [ -n "$pane" ]; then printf '%s\\t%s\\n' "$pane" "$text" >> '${injectLog}'; fi
    ;;
  load-buffer)
    cat >/dev/null # consume the multi-line payload; the destination is on paste-buffer
    ;;
  paste-buffer)
    # The multi-line inject's destination pane — log it like a send-keys inject.
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    if [ -n "$pane" ]; then printf '%s\\tPASTE\\n' "$pane" >> '${injectLog}'; fi
    ;;
esac
exit 0
`;
}

// ps: both pane pids run claude, so findAgentInPane resolves each to an agent.
function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${PID_3D}' '1' 'claude'
printf '%s %s %s\\n' '${PID_RIG}' '1' 'claude'
exit 0
`;
}

interface Harness {
  cfgDir: string;
  dir3d: string;
  dirRig: string;
  injectLog: string;
  setMode: (m: 'normal' | 'empty' | 'partial') => void;
}

function makeHarness(): Harness {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-misroute-'));
  // Distinct project dirs so routeMatchesPane can confirm same-project for %5.
  const dir3d = join(cfgDir, 'proj-3d');
  const dirRig = join(cfgDir, 'proj-rig');
  mkdirSync(dir3d, { recursive: true });
  mkdirSync(dirRig, { recursive: true });
  const injectLog = join(cfgDir, 'inject.log');

  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  // Registration points at %2 (the [rig] agent) — the single global slot's last
  // writer, exactly the pane the bug delivered the reply into.
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify({ paneId: PANE_RIG, cwd: dirRig }),
  );
  // routes.json: outbound message 500 originated from the [3d] agent (%5).
  writeFileSync(
    join(cfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([{ id: 500, paneId: PANE_3D, cwd: dir3d, ts: Math.floor(Date.now() / 1000) }]),
  );

  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, dir3d, dirRig, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'tmux-mode'), 'normal');

  return {
    cfgDir,
    dir3d,
    dirRig,
    injectLog,
    setMode: (m) => writeFileSync(join(cfgDir, 'tmux-mode'), m),
  };
}

function injectedLines(injectLog: string): string[] {
  if (!existsSync(injectLog)) return [];
  return readFileSync(injectLog, 'utf8').split('\n').filter((l) => l.length > 0);
}

async function startDaemon(cfgDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
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

// A scripted Telegram fake. The test pushes update batches; sends + reply_markup
// presence are captured so we can assert "picker posted" vs "inject happened".
interface FakeTg {
  port: number;
  pushReply: (updateId: number, messageId: number, replyToId: number, text: string) => void;
  sends: Array<{ text: string; hasMarkup: boolean }>;
  reactions: Array<Record<string, unknown>>;
  stop: () => void;
}

function startFakeTg(): FakeTg {
  const queue: unknown[][] = [];
  const sends: Array<{ text: string; hasMarkup: boolean }> = [];
  const reactions: Array<Record<string, unknown>> = [];
  let delivered = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (delivered < queue.length) {
          const batch = queue[delivered];
          delivered += 1;
          return Response.json({ ok: true, result: batch });
        }
        await Bun.sleep(300);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as { text: string; reply_markup?: unknown };
        sends.push({ text: body.text, hasMarkup: body.reply_markup !== undefined });
        return Response.json({ ok: true, result: { message_id: 9000 + sends.length } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        reactions.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  return {
    port: server.port,
    sends,
    reactions,
    pushReply: (updateId, messageId, replyToId, text) => {
      const nowSec = Math.floor(Date.now() / 1000);
      queue.push([
        {
          update_id: updateId,
          message: {
            message_id: messageId,
            from: { id: 1, first_name: 'Alex' },
            chat: { id: 1 },
            date: nowSec,
            text,
            reply_to_message: { message_id: replyToId, date: nowSec, chat: { id: 1 }, text: 'orig' },
          },
        },
      ]);
    },
    stop: () => server.stop(true),
  };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await Bun.sleep(50);
  }
}

test('HAPPY PATH: a reply to agent-B (%5) routes to %5, never to the registration pane %2', async () => {
  const h = makeHarness();
  const tg = startFakeTg();
  h.setMode('normal');
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  tg.pushReply(600, 10, 500, 'reply to the 3d agent');

  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await Bun.sleep(300); // let any stray inject settle

  const lines = injectedLines(h.injectLog);
  // The reply landed in %5 (its origin) — and NOT in %2 (the registration pane).
  expect(lines.some((l) => l.startsWith(`${PANE_3D}\t`))).toBe(true);
  expect(lines.some((l) => l.startsWith(`${PANE_RIG}\t`))).toBe(false);
  // Direct inject, no picker posted.
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(false);
}, 15_000);

test('THE MISROUTE (#53): origin %5 recognized but only %2 visible → picker, NEVER injects into %2', async () => {
  const h = makeHarness();
  const tg = startFakeTg();
  // The realistic flake: the recognition snapshot can't confirm %5, and the
  // candidate snapshot shows ONLY %2 (the registration's last writer). The OLD
  // code's `candidates.length === 1` path deterministically dumped the reply into
  // %2 — the exact misroute. It must now post the picker instead.
  h.setMode('partial');
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  tg.pushReply(600, 10, 500, 'reply meant for the 3d agent');

  // The picker is a sendMessage carrying reply_markup.
  await waitFor(() => tg.sends.some((s) => s.hasMarkup));
  await Bun.sleep(300); // let any stray inject settle

  // THE FIX: a recognized reply with an unconfirmable origin posts the picker…
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(true);
  // …and NEVER silently injects into the wrong pane (%2) — nor anywhere at all.
  const lines = injectedLines(h.injectLog);
  expect(lines.some((l) => l.startsWith(`${PANE_RIG}\t`))).toBe(false);
  expect(lines.length).toBe(0);
}, 15_000);

test('FLAKE empty snapshot: recognized reply does NOT misroute into %2 (no-agent reply, no inject)', async () => {
  const h = makeHarness();
  const tg = startFakeTg();
  // Fully empty snapshot: nothing to pick. The reply must NOT be force-injected
  // into the registration pane %2; a no-agent reply is the safe outcome.
  h.setMode('empty');
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  tg.pushReply(600, 10, 500, 'reply while everything is invisible');

  await waitFor(() => tg.sends.length > 0);
  await Bun.sleep(300);

  // No inject anywhere — and specifically not into %2.
  const lines = injectedLines(h.injectLog);
  expect(lines.length).toBe(0);
  expect(lines.some((l) => l.startsWith(`${PANE_RIG}\t`))).toBe(false);
}, 15_000);

test('REGRESSION unrecognized + multi-agent: posts the picker (can\'t guess the origin)', async () => {
  const h = makeHarness();
  const tg = startFakeTg();
  h.setMode('normal'); // both agents visible
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  // Reply to an id NOT in routes.json → unrecognized. Two agents visible, so an
  // unrecognized reply correctly posts the picker (can't guess the origin).
  tg.pushReply(601, 11, 999999, 'reply to an unknown message');
  await waitFor(() => tg.sends.some((s) => s.hasMarkup));
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(true);
  // No silent inject for an unrecognized multi-agent reply.
  const lines = injectedLines(h.injectLog);
  expect(lines.length).toBe(0);
}, 15_000);

test('REGRESSION single-agent: an UNRECOGNIZED reply with ONE visible agent injects directly (no picker)', async () => {
  const h = makeHarness();
  const tg = startFakeTg();
  // partial = only %2 visible. An UNRECOGNIZED reply (origin unknown) with a
  // single visible agent is unambiguous and MUST inject directly — this is the
  // path preserved by `if (!recognized && candidates.length === 1)`. Without that
  // branch the fix would have over-corrected every single-agent reply into a tap.
  h.setMode('partial');
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  tg.pushReply(602, 12, 888888, 'unrecognized reply, one agent here');
  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await Bun.sleep(300);

  const lines = injectedLines(h.injectLog);
  // Injected directly into the single visible agent (%2) — and NO picker posted.
  expect(lines.some((l) => l.startsWith(`${PANE_RIG}\t`))).toBe(true);
  expect(tg.sends.some((s) => s.hasMarkup)).toBe(false);
}, 15_000);

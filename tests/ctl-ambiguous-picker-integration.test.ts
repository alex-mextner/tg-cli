import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

// tg-cli#72: an ambiguous route / a reply to a GONE agent must post the inline-
// keyboard PICKER (tappable buttons, like /agent) — NOT the old plain-text
// "ambiguous target — candidates:" dump. When the addressed agent is gone the
// picker must SAY so ("That agent (<label>) is no longer running"). Tapping a
// button routes to the chosen pane. The recognized-single-target happy path still
// injects directly (no picker).
//
// Drives the REAL daemon against a fake Telegram + a fake tmux/ps. Two agents
// mirror the CTO's screenshot: %0 = hyperide, %2 = agent-tools.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const PANE_HYPER = '%0';
const PID_HYPER = 9000;
const PANE_TOOLS = '%2';
const PID_TOOLS = 2002;

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

// tmux shim. Pane visibility depends on <cfgDir>/tmux-mode:
//   "both"  → both agent panes visible (the ambiguous case)
//   "tools" → ONLY %2 visible (hyperide's pane %0 is GONE — the reply-to-gone case)
//   "hyper" → ONLY %0 visible (single agent → happy path direct inject)
// Every `send-keys -t <pane> -l <text>` and multi-line `paste-buffer -t <pane>`
// is logged as "<pane>\t…" so the test can assert WHICH pane received the inject.
function fakeTmux(cfgDir: string, dirHyper: string, dirTools: string, injectLog: string): string {
  return `#!/bin/sh
sub="$1"; shift
mode=$(cat '${join(cfgDir, 'tmux-mode')}' 2>/dev/null || echo both)
case "$sub" in
  list-panes)
    show_hyper=0; show_tools=0
    case "$mode" in
      both)  show_hyper=1; show_tools=1;;
      tools) show_tools=1;;
      hyper) show_hyper=1;;
    esac
    # 7-field core PANE_FORMAT carries #{window_name} (field 6, before the path) —
    # the daemon reads window names from the core snapshot now (tg-cli#75), not a
    # separate call. The CTO's screenshot window names: 'hyperide', 'agent-tools'.
    [ "$show_hyper" = "1" ] && printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'shyper' '4' '${PANE_HYPER}' '${PID_HYPER}' 'claude' 'hyperide' '${dirHyper}'
    [ "$show_tools" = "1" ] && printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'stools' '4' '${PANE_TOOLS}' '${PID_TOOLS}' 'claude' 'agent-tools' '${dirTools}'
    ;;
  display-message)
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    if [ "$pane" = "${PANE_HYPER}" ]; then printf '%s\\n' '${dirHyper}'
    elif [ "$pane" = "${PANE_TOOLS}" ]; then printf '%s\\n' '${dirTools}'
    else printf 'main\\n'; fi
    ;;
  send-keys)
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
    cat >/dev/null
    ;;
  paste-buffer)
    pane=""
    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then pane="$2"; fi; shift; done
    if [ -n "$pane" ]; then printf '%s\\tPASTE\\n' "$pane" >> '${injectLog}'; fi
    ;;
esac
exit 0
`;
}

function fakePs(): string {
  return `#!/bin/sh
printf '%s %s %s\\n' '${PID_HYPER}' '1' 'claude'
printf '%s %s %s\\n' '${PID_TOOLS}' '1' 'claude'
exit 0
`;
}

interface Harness {
  cfgDir: string;
  dirHyper: string;
  dirTools: string;
  injectLog: string;
  setMode: (m: 'both' | 'tools' | 'hyper') => void;
}

// `regs` lets a test register one or both agents (the per-pane registration SET).
function makeHarness(regs: Array<{ paneId: string; cwd: string }>, routes: unknown[] = []): Harness {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-ambig-'));
  const dirHyper = join(cfgDir, 'hyperide');
  const dirTools = join(cfgDir, 'agent-tools');
  mkdirSync(dirHyper, { recursive: true });
  mkdirSync(dirTools, { recursive: true });
  const injectLog = join(cfgDir, 'inject.log');

  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify(regs));
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify(routes));

  mkdirSync(join(cfgDir, 'bin'));
  writeFileSync(join(cfgDir, 'bin', 'tmux'), fakeTmux(cfgDir, dirHyper, dirTools, injectLog), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'bin', 'ps'), fakePs(), { mode: 0o755 });
  writeFileSync(join(cfgDir, 'tmux-mode'), 'both');

  return { cfgDir, dirHyper, dirTools, injectLog, setMode: (m) => writeFileSync(join(cfgDir, 'tmux-mode'), m) };
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

interface SentMessage {
  text: string;
  hasMarkup: boolean;
  buttons: Array<{ text: string; callback_data: string }>;
}

interface FakeReaction {
  messageId: number;
  emoji: string;
}

interface FakeTg {
  port: number;
  pushText: (updateId: number, messageId: number, text: string) => void;
  pushReply: (updateId: number, messageId: number, replyToId: number, text: string) => void;
  pushCallback: (updateId: number, data: string, onMessageId: number) => void;
  sends: SentMessage[];
  reactions: FakeReaction[];
  stop: () => void;
}

function startFakeTg(): FakeTg {
  const queue: unknown[][] = [];
  const sends: SentMessage[] = [];
  const reactions: FakeReaction[] = [];
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
        await Bun.sleep(150);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        const body = (await req.json()) as {
          text: string;
          reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
        };
        const rows = body.reply_markup?.inline_keyboard ?? [];
        sends.push({
          text: body.text,
          hasMarkup: body.reply_markup !== undefined,
          buttons: rows.flat(),
        });
        return Response.json({ ok: true, result: { message_id: 9000 + sends.length } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        const body = (await req.json()) as {
          message_id: number;
          reaction?: Array<{ type: string; emoji?: string }>;
        };
        for (const r of body.reaction ?? []) {
          reactions.push({ messageId: body.message_id, emoji: r.emoji ?? '' });
        }
        return Response.json({ ok: true, result: true });
      }
      // answerCallbackQuery / editMessageText — all OK.
      return Response.json({ ok: true, result: true });
    },
  });
  servers.push(server);

  const nowSec = (): number => Math.floor(Date.now() / 1000);
  return {
    port: server.port,
    sends,
    reactions,
    pushText: (updateId, messageId, text) => {
      queue.push([
        { update_id: updateId, message: { message_id: messageId, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec(), text } },
      ]);
    },
    pushReply: (updateId, messageId, replyToId, text) => {
      queue.push([
        {
          update_id: updateId,
          message: {
            message_id: messageId,
            from: { id: 1, first_name: 'Alex' },
            chat: { id: 1 },
            date: nowSec(),
            text,
            reply_to_message: { message_id: replyToId, date: nowSec(), chat: { id: 1 }, text: 'orig' },
          },
        },
      ]);
    },
    pushCallback: (updateId, data, onMessageId) => {
      queue.push([
        {
          update_id: updateId,
          callback_query: {
            id: `cb${updateId}`,
            from: { id: 1, first_name: 'Alex' },
            message: { message_id: onMessageId, chat: { id: 1 }, date: nowSec() },
            data,
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

const pickerOf = (sends: SentMessage[]): SentMessage | undefined => sends.find((s) => s.hasMarkup);

test('AMBIGUOUS plain message → inline-keyboard picker (buttons, NO "candidates:" text dump)', async () => {
  // Two registered agents, both live → pickTargetPaneFromSet returns ambiguous.
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' }, // cwd empty so tier-3 cwd match can't collapse it
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  tg.pushText(700, 20, 'do the thing');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  await Bun.sleep(200);

  const picker = pickerOf(tg.sends);
  expect(picker).toBeDefined();
  // It is a PICKER, not a text dump.
  expect(picker!.text).not.toContain('candidates:');
  expect(picker!.text).not.toContain('ambiguous target');
  // One button per live candidate, with distinct project labels.
  expect(picker!.buttons.length).toBe(2);
  const labels = picker!.buttons.map((b) => b.text).join(' | ');
  expect(labels).toContain('hyperide');
  expect(labels).toContain('agent-tools');
  // Buttons carry tga: callback data (the /agent picker callback path).
  expect(picker!.buttons.every((b) => b.callback_data.startsWith('tga:'))).toBe(true);
  // No silent inject while the human picks.
  expect(injectedLines(h.injectLog).length).toBe(0);
}, 15_000);

test('TAP a button → routes the pending message to the chosen pane', async () => {
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  tg.pushText(700, 20, 'route me');
  await waitFor(() => pickerOf(tg.sends) !== undefined);

  const picker = pickerOf(tg.sends)!;
  // Tap the agent-tools button.
  const toolsBtn = picker.buttons.find((b) => b.text.includes('agent-tools'))!;
  expect(toolsBtn).toBeDefined();
  // The picker was sent as messageId 9001 (first send). The callback must come
  // from that same message (the daemon checks message_id equality).
  tg.pushCallback(701, toolsBtn.callback_data, 9000 + tg.sends.indexOf(picker) + 1);

  await waitFor(() => injectedLines(h.injectLog).length > 0);
  await Bun.sleep(200);

  const lines = injectedLines(h.injectLog);
  // The tap injected into %2 (agent-tools) and NOT %0 (hyperide)…
  const toolsLines = lines.filter((l) => l.startsWith(`${PANE_TOOLS}\t`));
  expect(toolsLines.length).toBeGreaterThan(0);
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(false);
  // …carrying the ORIGINAL message text (deferText routed verbatim), not an empty
  // or wrong payload. The wrapped inject embeds the raw '{msg}' so 'route me' is
  // present in what reached the pane (guards a wrapping/content regression).
  expect(toolsLines.join('\n')).toContain('route me');
}, 15_000);

test('REPLY to a now-GONE agent → picker WITH "no longer running" notice naming the gone agent', async () => {
  // routes.json: outbound message 500 originated from the hyperide agent (%0).
  // mode "tools": %0 is GONE (only agent-tools %2 is live). The reply's recognized
  // origin is gone → the picker must say so and offer the live agent(s).
  const h = makeHarness(
    [{ paneId: PANE_TOOLS, cwd: '' }],
    [{ id: 500, paneId: PANE_HYPER, cwd: '', ts: Math.floor(Date.now() / 1000) }],
  );
  // Record the route with the hyperide cwd so the gone label reads "hyperide".
  writeFileSync(
    join(h.cfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([{ id: 500, paneId: PANE_HYPER, cwd: h.dirHyper, ts: Math.floor(Date.now() / 1000) }]),
  );
  const tg = startFakeTg();
  h.setMode('tools'); // hyperide gone, agent-tools live
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  tg.pushReply(702, 22, 500, 'reply meant for the now-gone hyperide agent');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  await Bun.sleep(200);

  const picker = pickerOf(tg.sends);
  expect(picker).toBeDefined();
  // Says the agent is gone, and NAMES it (cwd basename → "hyperide").
  expect(picker!.text).toContain('no longer running');
  expect(picker!.text).toContain('hyperide');
  // No plain-text candidate dump.
  expect(picker!.text).not.toContain('candidates:');
  // The live agent is a button to pick.
  expect(picker!.buttons.some((b) => b.text.includes('agent-tools'))).toBe(true);
  // No silent inject into the surviving agent.
  expect(injectedLines(h.injectLog).length).toBe(0);
}, 15_000);

test('HAPPY PATH: a single registered live agent → direct inject, NO picker', async () => {
  // Only hyperide registered + visible → unambiguous, inject directly.
  const h = makeHarness([{ paneId: PANE_HYPER, cwd: '' }]);
  const tg = startFakeTg();
  h.setMode('hyper');
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  tg.pushText(703, 24, 'just do it');

  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await Bun.sleep(200);

  const lines = injectedLines(h.injectLog);
  // Injected straight into %0 — and NO picker posted.
  expect(lines.some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(true);
  expect(pickerOf(tg.sends)).toBeUndefined();
}, 15_000);

test('AMBIGUOUS control verb (/stop, no routable text) → select-only picker, NO inject, NO 👀 receipt', async () => {
  // Two registered live agents + a /stop (Escape) — no text to route through a
  // tap. The old path dumped "ambiguous target — candidates: …" as plain text;
  // now it posts the live agents as a select-only picker. Because a select-only
  // tap does NOT re-run the control verb, the source message must earn NO 👀
  // (the finding-2 fix: injectViaTarget returns false on this branch).
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('both');
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  const stopMsgId = 26;
  tg.pushText(704, stopMsgId, '/stop');

  await waitFor(() => pickerOf(tg.sends) !== undefined);
  await Bun.sleep(300);

  const picker = pickerOf(tg.sends);
  expect(picker).toBeDefined();
  // Buttons, not a plain-text candidate dump.
  expect(picker!.text).not.toContain('candidates:');
  expect(picker!.text).not.toContain('ambiguous target');
  expect(picker!.buttons.length).toBe(2);
  expect(picker!.buttons.every((b) => b.callback_data.startsWith('tga:'))).toBe(true);
  // /stop was NOT injected into either pane (no Escape sent).
  expect(injectedLines(h.injectLog).length).toBe(0);
  // And the source /stop message earned NO 👀 — it did not execute.
  expect(tg.reactions.some((r) => r.messageId === stopMsgId && r.emoji === '👀')).toBe(false);
}, 15_000);

test('candidatesForPicker drops a discovery pane that is NOT a live agent (no synthetic dead button)', async () => {
  // Registration set names BOTH panes, but the tmux shim shows ONLY agent-tools
  // (%0/hyperide is gone). A fresh non-reply message is ambiguous at the SET tier
  // (two registered ids) yet only ONE is a live agent. The picker must offer JUST
  // the live agent — never a synthetic button for the gone %0 (the finding-1 fix:
  // candidatesForPicker filters to live agent candidates, it does not fabricate).
  const h = makeHarness([
    { paneId: PANE_HYPER, cwd: '' },
    { paneId: PANE_TOOLS, cwd: '' },
  ]);
  const tg = startFakeTg();
  h.setMode('tools'); // only %2 (agent-tools) is a live agent pane
  const daemon = await startDaemon(h.cfgDir, tg.port);
  procs.push(daemon);

  tg.pushText(705, 28, 'do the thing with one gone');

  // With a single live agent this resolves directly (inject) OR — if the set tier
  // narrows to the one registered live pane — injects without a picker. Either
  // way: exactly the live pane is addressed, and NO button is ever offered for
  // the gone %0.
  await waitFor(() => injectedLines(h.injectLog).length > 0 || tg.sends.length > 0);
  await Bun.sleep(200);

  const picker = pickerOf(tg.sends);
  if (picker) {
    // If a picker did appear, it must NOT contain a button for the gone hyperide.
    expect(picker.buttons.some((b) => b.text.includes('hyperide'))).toBe(false);
    expect(picker.buttons.every((b) => b.callback_data.startsWith('tga:'))).toBe(true);
  }
  // Nothing was injected into the gone %0.
  expect(injectedLines(h.injectLog).some((l) => l.startsWith(`${PANE_HYPER}\t`))).toBe(false);
}, 15_000);

import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { NO_AGENT_REPLY } from '../tg-ctl';

// Full daemon round-trip against a local Bot-API fake (spec §11: "the daemon
// is spawned as a real subprocess against the fake"). tmux is PATH-shimmed to
// an argv-logging stub that prints an EMPTY pane list, so (1) the user's real
// tmux server is never touched and (2) every inject degrades to the no-agent
// guard reply — capturable via the fake's sendMessage endpoint.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const nowSec = Math.floor(Date.now() / 1000);

// Scripted updates, served at-most-once via the offset param:
// 100 → allowed sender, plain text  → inject attempt → no-agent guard reply
// 101 → /status                     → status reply containing "running"
// 102 → stale (older than 300s)     → "skipped 1 stale messages" notice
// 103 → DISALLOWED sender           → no reply, but the offset must still advance
// 104 → photo from allowed sender   → getFile + download, then no-agent reply
const QUEUE = [
  { update_id: 100, message: { message_id: 1, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: 'hello agent' } },
  { update_id: 101, message: { message_id: 2, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: '/status' } },
  { update_id: 102, message: { message_id: 3, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec - 9000, text: 'old news' } },
  { update_id: 103, message: { message_id: 4, from: { id: 999, first_name: 'Mallory' }, chat: { id: 1 }, date: nowSec, text: 'evil command' } },
  {
    update_id: 104,
    message: {
      message_id: 5,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      caption: 'pic',
      // Size-ascending renditions — the daemon must pick the largest.
      photo: [
        { file_id: 'photo-small', file_size: 100 },
        { file_id: 'photo-big', file_size: 5000 },
      ],
    },
  },
];

const offsets: number[] = []; // every offset getUpdates was called with
const sent: { chat_id: number; text: string }[] = []; // sendMessage bodies
const reactions: { chat_id: number; message_id: number; reaction: { type: string; emoji: string }[] }[] = [];
let serveCount = 0; // how many times the queue was (re-)delivered
let fetchedFileId: string | null = null;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      offsets.push(offset);
      const pending = QUEUE.filter((u) => u.update_id >= offset);
      if (pending.length) {
        serveCount += 1;
        return Response.json({ ok: true, result: pending });
      }
      await Bun.sleep(1500); // pace the loop like the real long-poll
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push((await req.json()) as { chat_id: number; text: string });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      reactions.push((await req.json()) as (typeof reactions)[number]);
      return Response.json({ ok: true, result: true });
    }
    if (url.pathname.endsWith('/getFile')) {
      fetchedFileId = url.searchParams.get('file_id');
      return Response.json({ ok: true, result: { file_path: 'photos/big.jpg' } });
    }
    if (url.pathname.startsWith('/file/bot')) {
      return new Response('JPEGDATA');
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-daemon-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
const pidFile = join(cfgDir, 'tg-ctl.123.pid');

// tmux PATH shim: log argv, print NOTHING — parsePaneList('') = no panes, so
// discovery yields no-agent and the daemon must answer with the guard text.
const shimDir = join(cfgDir, 'bin');
const shimLog = join(cfgDir, 'tmux-calls.log');
mkdirSync(shimDir);
writeFileSync(join(shimDir, 'tmux'), `#!/bin/sh\necho "$@" >> '${shimLog}'\nexit 0\n`, { mode: 0o755 });

const procs: Subprocess[] = [];

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  for (const p of procs) {
    expect(() => process.kill(p.pid, 0)).toThrow();
  }
  server.stop(true);
});

test('daemon round-trip: stale notice, guard replies, /status, allowlist drop, media download', async () => {
  // Daemon stderr goes to a file, not a pipe — post-mortem readable, can't block.
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir, // media lands under $HOME/.cache/tg-cli/inbound
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(daemon);
  closeSync(logFd);

  // Wait until the whole batch is processed: 4 sends captured AND the next
  // getUpdates confirmed offset 105 (max update_id + 1).
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    if (sent.length >= 4 && reactions.length >= 1 && offsets.includes(105)) break;
    await Bun.sleep(100);
  }

  // (c) one stale notice for the whole batch, sent BEFORE any action.
  expect(sent[0]?.text).toBe('skipped 1 stale messages');
  // (a) prompt from allowed sender → inject attempted → no panes → guard reply.
  expect(sent[1]?.text).toBe(NO_AGENT_REPLY);
  // (b) /status → composed status names THIS daemon as running.
  expect(sent[2]?.text).toContain(`tg-ctl: running (pid ${daemon.pid})`);
  expect(sent[2]?.text).toContain('offset: 105');
  // (e) photo → downloaded, then the inject for it degrades to the guard too.
  expect(sent[3]?.text).toBe(NO_AGENT_REPLY);
  expect(sent).toHaveLength(4);
  for (const m of sent) expect(m.chat_id).toBe(1);

  // (d) disallowed sender: nothing echoed anywhere, yet the offset advanced —
  // the queue was served exactly ONCE and the next poll confirmed past it.
  expect(sent.some((m) => m.text.includes('evil'))).toBe(false);
  expect(offsets[0]).toBe(0); // no offset file yet on first poll
  expect(offsets).toContain(105);
  expect(serveCount).toBe(1);
  expect(readFileSync(join(cfgDir, 'tg-ctl.123.offset'), 'utf8').trim()).toBe('105');

  // Media: largest rendition resolved via getFile, bytes written under the
  // daemon-chosen name <update_id>.jpg (never the Telegram basename).
  expect(fetchedFileId).toBe('photo-big');
  const saved = join(cfgDir, '.cache', 'tg-cli', 'inbound', '104.jpg');
  expect(readFileSync(saved, 'utf8')).toBe('JPEGDATA');

  // Delivery receipts (👀): ONLY the handled /status message gets one. The
  // failed injects (no agent pane → guard reply) must NOT be acknowledged —
  // the error reply is the failure signal; a 👀 would claim delivery.
  expect(reactions).toEqual([
    { chat_id: 1, message_id: 2, reaction: [{ type: 'emoji', emoji: '👀' }] },
  ]);

  // The PATH shim actually intercepted discovery — without this the test
  // could pass by accident while talking to a real tmux server.
  expect(readFileSync(shimLog, 'utf8')).toContain('list-panes');

  // Clean shutdown.
  daemon.kill('SIGTERM');
  const exited = await Promise.race([
    daemon.exited,
    Bun.sleep(4000).then(() => 'timeout' as const),
  ]);
  expect(exited).not.toBe('timeout');
  expect(daemon.exitCode).toBe(0);
  expect(existsSync(pidFile)).toBe(false);
}, 15_000);

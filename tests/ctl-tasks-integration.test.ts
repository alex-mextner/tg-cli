import { afterAll, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// /tasks round-trip (tg-cli#115): the daemon is spawned as a real subprocess
// against a Bot-API fake; `task` and `gh` are PATH-shimmed to argv-logging
// stubs emitting fixture JSON (same trick as the tmux shim), so the test pins
// the whole pipeline — command parse → task-cli spawn → gh PR/CI fold → rich
// table send — without touching the real CLIs or network.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const nowSec = Math.floor(Date.now() / 1000);

// 200 → /tasks            → rich table: open tickets only, PR + CI cells
// 201 → /tasks done       → rich table: the done ticket, no open one
// 202 → /tasks ghost      → plain error reply (no agents running), no rich send
const QUEUE = [
  { update_id: 200, message: { message_id: 21, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: '/tasks' } },
  { update_id: 201, message: { message_id: 22, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: '/tasks done' } },
  { update_id: 202, message: { message_id: 23, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: nowSec, text: '/tasks ghost' } },
];

const sent: { chat_id: number; text: string }[] = [];
const richSent: { chat_id: number; rich_message: { html: string } }[] = [];
const reactions: { message_id: number; reaction: { emoji: string }[] }[] = [];
const offsets: number[] = [];

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
      offsets.push(offset);
      const pending = QUEUE.filter((u) => u.update_id >= offset);
      if (pending.length) return Response.json({ ok: true, result: pending });
      await Bun.sleep(1500);
      return Response.json({ ok: true, result: [] });
    }
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push((await req.json()) as (typeof sent)[number]);
      return Response.json({ ok: true, result: { message_id: 900 + sent.length } });
    }
    if (url.pathname.endsWith('/sendRichMessage')) {
      richSent.push((await req.json()) as (typeof richSent)[number]);
      return Response.json({ ok: true, result: { message_id: 800 + richSent.length } });
    }
    if (url.pathname.endsWith('/setMessageReaction')) {
      reactions.push((await req.json()) as (typeof reactions)[number]);
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');

// PATH shims: tmux → empty pane list (no agents); task/gh → fixture JSON.
const shimDir = join(cfgDir, 'bin');
mkdirSync(shimDir);
const taskCallsLog = join(cfgDir, 'task-calls.log');
const ghCallsLog = join(cfgDir, 'gh-calls.log');
writeFileSync(join(shimDir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const TASK_FIXTURE = JSON.stringify([
  {
    project: 'alex/demo',
    backend: 'github-issues',
    current: true,
    error: null,
    tickets: [
      { id: '#7', title: 'Fix the parser', state: 'todo', url: 'https://github.com/alex/demo/issues/7', labels: [], what: '', due: '2026-07-10' },
      { id: '#8', title: 'Old finished thing', state: 'done', url: 'https://github.com/alex/demo/issues/8', labels: [], what: '', due: '' },
    ],
  },
]);
const GH_FIXTURE = JSON.stringify([
  {
    number: 12,
    title: 'fix: the parser',
    body: 'Closes #7',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ state: 'SUCCESS' }],
    url: 'https://github.com/alex/demo/pull/12',
  },
]);
writeFileSync(join(cfgDir, 'task-fixture.json'), TASK_FIXTURE);
writeFileSync(join(cfgDir, 'gh-fixture.json'), GH_FIXTURE);
writeFileSync(join(shimDir, 'task'), `#!/bin/sh\necho "$@" >> '${taskCallsLog}'\ncat '${join(cfgDir, 'task-fixture.json')}'\n`, { mode: 0o755 });
writeFileSync(join(shimDir, 'gh'), `#!/bin/sh\necho "$@" >> '${ghCallsLog}'\ncat '${join(cfgDir, 'gh-fixture.json')}'\n`, { mode: 0o755 });

const reg = createDaemonRegistry();

afterAll(async () => {
  await reapDaemons(reg);
  server.stop(true);
});

test('/tasks round-trip: rich table with PR/CI, status filter, unmatched-agent error', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = await spawnDaemon(reg, {
    tgCtlPath: TG_CTL,
    cfgDir,
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    logFd,
  });
  closeSync(logFd);
  expect(daemon.pid).toBeGreaterThan(0);

  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    if (richSent.length >= 2 && sent.length >= 1 && offsets.includes(203)) break;
    await Bun.sleep(100);
  }

  // (a) bare /tasks → rich table with the OPEN ticket only, PR + CI + review folded in.
  const first = richSent[0]?.rich_message.html ?? '';
  expect(first).toContain('issues/7'); // ticket link
  expect(first).toContain('Fix the parser');
  expect(first).toContain('pull/12'); // linked PR
  expect(first).toContain('approved'); // reviewDecision mark
  expect(first).toContain('✓ pass'); // CI verdict from statusCheckRollup
  expect(first).toContain('2026-07-10'); // due date
  expect(first).not.toContain('issues/8'); // done ticket filtered by default

  // (b) /tasks done → the done ticket, not the open one.
  const second = richSent[1]?.rich_message.html ?? '';
  expect(second).toContain('issues/8');
  expect(second).toContain('Old finished thing');
  expect(second).not.toContain('issues/7');

  // (c) /tasks ghost → plain error reply, never a fabricated board.
  const errReply = sent.find((s) => s.text.includes("no agent matching 'ghost'"));
  expect(errReply).toBeDefined();

  // (d) the successful /tasks messages earned their 👀 ack; the error one did not.
  const ackedIds = reactions.map((r) => r.message_id);
  expect(ackedIds).toContain(21);
  expect(ackedIds).toContain(22);
  expect(ackedIds).not.toContain(23);

  // (e) the shims were driven with the expected argv shapes.
  const taskCalls = readFileSync(taskCallsLog, 'utf8');
  expect(taskCalls).toContain('list --all --json');
  const ghCalls = readFileSync(ghCallsLog, 'utf8');
  expect(ghCalls).toContain('pr list --repo alex/demo');
});

import { afterEach, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// Integration test for the /next <ticket-id> bot command against a fake Bot API, with stub
// `pm` and `gh` binaries and a REAL git repo on disk (git status/branch need no stub — the
// daemon shells out to the system `git`, same as the existing git-state-banner integration
// tests do). Proves the daemon composes pm-cli's ticket state + live git status + PR/CI rollup
// into one rich-HTML card via sendRichMessage, and that each source degrades independently
// instead of blanking the whole card.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const reg = createDaemonRegistry();
const servers: Array<{ stop: (closeActive?: boolean) => void | Promise<void> }> = [];

afterEach(async () => {
  await reapDaemons(reg);
  for (const s of servers.splice(0)) await s.stop(true);
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

async function startDaemon(cfgDir: string, binDir: string, apiPort: number): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  try {
    const daemon = await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${apiPort}`,
      },
      logFd,
      socketWaitMs: 8000,
    });
    expect(existsSync(join(cfgDir, 'tg-ctl.123.sock'))).toBe(true);
    return daemon;
  } finally {
    closeSync(logFd);
  }
}

function initGitRepo(dir: string, opts: { dirty?: boolean; branch?: string } = {}): void {
  const run = (...argv: string[]): void => {
    const r = Bun.spawnSync(argv, { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
    if (r.exitCode !== 0) throw new Error(`git repo setup failed: ${argv.join(' ')}`);
  };
  run('git', 'init', '-q', '-b', opts.branch ?? 'main');
  run('git', 'config', 'user.email', 'a@x.test');
  run('git', 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  run('git', 'add', 'README.md');
  run('git', 'commit', '-q', '-m', 'init');
  if (opts.dirty) writeFileSync(join(dir, 'README.md'), 'hi again\n');
}

function tmuxStub(binDir: string, projectDir: string): void {
  writeFileSync(
    join(binDir, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'proj' '' '${projectDir}'
    ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(binDir, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n'\n", { mode: 0o755 });
}

// A `pm why <id> --json` stub. `argvLog` records every invocation ("<id> ...") so a test can
// assert which candidate id(s) the daemon tried, in order.
function pmStub(binDir: string, argvLog: string, byId: Record<string, { exitCode: number; stdout: string }>): void {
  const cases = Object.entries(byId)
    .map(([id, r]) => `  '${id}') printf '%s\\n' '${r.stdout.replace(/'/g, "'\\''")}'; exit ${r.exitCode} ;;`)
    .join('\n');
  writeFileSync(
    join(binDir, 'pm'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${argvLog}'
if [ "$1" = "why" ]; then
  case "$2" in
${cases}
  *) echo "error: no work item '$2'" >&2; exit 2 ;;
  esac
fi
exit 1
`,
    { mode: 0o755 },
  );
}

function ghStub(binDir: string, invocationLog: string, prsJson: string): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> '${invocationLog}'\ncat <<'JSON'\n${prsJson}\nJSON\n`,
    { mode: 0o755 },
  );
}

function mkServer(cmdText: string, replyToMessageId: number | null, richMessages: any[]) {
  let served = false;
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!served) {
          served = true;
          const message: any = {
            message_id: 10,
            from: { id: 1, first_name: 'Alex' },
            chat: { id: 1 },
            date: Math.floor(Date.now() / 1000),
            text: cmdText,
          };
          if (replyToMessageId !== null) message.reply_to_message = { message_id: replyToMessageId };
          return Response.json({ ok: true, result: [{ update_id: 900, message }] });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        richMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 88 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
}

test('/next composes pm why + live git status + PR/CI rollup into one rich-HTML card', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-next-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(cfgDir, 'project');
  mkdirSync(projectDir);
  initGitRepo(projectDir, { dirty: true, branch: 'feature/next-card' });
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([{ id: 77, paneId: '%1', cwd: projectDir, ts: 1 }]));

  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  tmuxStub(bin, projectDir);
  const pmLog = join(cfgDir, 'pm-invocation.txt');
  pmStub(bin, pmLog, {
    'task:HYP:HYP-1033': {
      exitCode: 0,
      stdout: JSON.stringify({
        id: 'task:HYP:HYP-1033',
        title: 'Fix the thing',
        state: 'ticketed',
        project: 'HYP',
        pm_labels: ['pm.stage:intake', 'pm.health:healthy'],
        evidence: [{ kind: 'task-record', uri: 'https://linear.app/x/HYP-1033', observed_at: 't' }],
        errors: [],
        next: { terminal: false, unknown_state: false, moves: [{ state: 'ready', missing_evidence: [] }] },
      }),
    },
  });
  const ghLog = join(cfgDir, 'gh-invocation.txt');
  ghStub(
    bin,
    ghLog,
    JSON.stringify([
      { number: 42, title: 'fix HYP-1033', url: 'https://gh/pr/42', body: '', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], reviewDecision: 'APPROVED' },
    ]),
  );

  const richMessages: any[] = [];
  const server = mkServer('/next HYP-1033', 77, richMessages);
  servers.push(server);

  await startDaemon(cfgDir, bin, server.port);

  expect(await waitFor(() => richMessages.length === 1)).toBe(true);
  const html = richMessages[0].rich_message.html as string;
  expect(html).toContain('href="https://linear.app/x/HYP-1033"');
  expect(html).toContain('task:HYP:HYP-1033');
  expect(html).toContain('state: <b>ticketed</b>');
  expect(html).toContain('next: ready');
  expect(html).toContain('git: feature/next-card (1 file changed)');
  expect(html).toContain('href="https://gh/pr/42"');
  expect(html).toContain('#42');
  expect(html).toContain('✓'); // CI pass
  expect(html).toContain('✅'); // review approved

  // pm why was tried with the project-guessed candidate id and succeeded on the first try
  // that matched (as-typed "HYP-1033" and "task:HYP-1033" fail closed with exit 2 first).
  const pmInvocations = readFileSync(pmLog, 'utf8').trim().split('\n');
  expect(pmInvocations[0]).toBe('why HYP-1033 --json');
  expect(pmInvocations.at(-1)).toBe('why task:HYP:HYP-1033 --json');
  expect(readFileSync(ghLog, 'utf8').split('|')[0]).toBe(realpathSync(projectDir));
}, 15_000);

test('/next: pm why finds no work item — card says so, daemon still sends a message, and skips the pointless git/gh spawns', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-next-notfound-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(cfgDir, 'project');
  mkdirSync(projectDir);
  // Anchor a resolvable scope via reply — proves the skip is about `why` having failed, not
  // merely "no scope was ever resolvable" (review finding #3, minor: wasted 20s-timeout gh spawn
  // on a failed lookup stalls every action queued behind it in the batch).
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([{ id: 77, paneId: '%1', cwd: projectDir, ts: 1 }]));

  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  tmuxStub(bin, projectDir);
  const pmLog = join(cfgDir, 'pm-invocation.txt');
  pmStub(bin, pmLog, {}); // every candidate id 404s (exit 2)
  const ghLog = join(cfgDir, 'gh-invocation.txt');
  ghStub(bin, ghLog, '[]');

  const richMessages: any[] = [];
  const server = mkServer('/next GHOST-1', 77, richMessages);
  servers.push(server);

  await startDaemon(cfgDir, bin, server.port);

  expect(await waitFor(() => richMessages.length === 1)).toBe(true);
  const html = richMessages[0].rich_message.html as string;
  expect(html).toContain('no pm work item found');
  expect(html).toContain('GHOST-1');
  expect(existsSync(ghLog)).toBe(false); // gh was never spawned for a failed pm-why lookup
}, 15_000);

test('/next: gh failing (exit 127, ENOENT-equivalent) does not blank the card, and is NOT reported as "no matching PR"', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-next-nogh-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(cfgDir, 'project');
  mkdirSync(projectDir);
  initGitRepo(projectDir);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 1 }));
  // w1 has no `project` field (a manually-created pm item, no task-cli ticket behind it), so
  // scope resolution can't fuzzy-match a project id — anchor it via the reply-to-message route
  // instead (the same mechanism resolveNextScopeDir tries first).
  writeFileSync(join(cfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([{ id: 77, paneId: '%1', cwd: projectDir, ts: 1 }]));

  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  tmuxStub(bin, projectDir);
  const pmLog = join(cfgDir, 'pm-invocation.txt');
  pmStub(bin, pmLog, {
    w1: {
      exitCode: 0,
      stdout: JSON.stringify({
        id: 'w1',
        title: 'Manually tracked item',
        state: 'seen',
        pm_labels: ['pm.stage:intake', 'pm.health:healthy'],
        evidence: [],
        errors: [],
        next: { terminal: false, unknown_state: false, moves: [{ state: 'classified', missing_evidence: [] }] },
      }),
    },
  });
  // An explicit `gh` stub that exits 127 (spawnGuarded's own ENOENT-equivalent code) — NOT simply
  // omitted from PATH. Review catch (tg-cli#289 round 2): `startDaemon` prepends the stub bin dir
  // but keeps the host PATH tail, so omitting the stub let this test silently run the REAL, host-
  // installed `gh` (whatever its auth/network/repo state happened to be) instead of proving the
  // spawn-failure path deterministically.
  const ghLog = join(cfgDir, 'gh-invocation.txt');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\nexit 127\n`, { mode: 0o755 });

  const richMessages: any[] = [];
  const server = mkServer('/next w1', 77, richMessages);
  servers.push(server);

  await startDaemon(cfgDir, bin, server.port);

  expect(await waitFor(() => richMessages.length === 1)).toBe(true);
  const html = richMessages[0].rich_message.html as string;
  expect(html).toContain('state: <b>seen</b>');
  expect(html).toContain('next: classified');
  expect(html).toContain('git: main (clean)');
  // gh missing must NOT fabricate "no matching PR found" — that's a false absence claim
  // (review catch, tg-cli#289 P2). Never blanks the card either.
  expect(html).toContain('PR/CI: — (gh unavailable)');
  expect(html).not.toContain('no matching PR found');
  expect(existsSync(ghLog)).toBe(true); // proves the stub actually ran (hermetic, not host `gh`)
}, 15_000);

test('/next: a `pm` binary predating --json (unrecognized-arguments exit 2) reports a real lookup failure, not "no pm work item found"', async () => {
  // The exact live failure mode advisor caught: `pm why <id> --json` against a `pm` without the
  // flag exits 2 (argparse's generic code) with "unrecognized arguments: --json" — identical exit
  // code to pm-cli's own "no such work item". Before classifyPmWhyFailure inspected stderr, this
  // rendered a confident false "no pm work item found for HYP-1033" — indistinguishable from a
  // genuinely untracked ticket, exactly the silent-rot failure /next exists to replace.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-next-stalepm-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(cfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 1 }));

  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  tmuxStub(bin, projectDir);
  writeFileSync(
    join(bin, 'pm'),
    `#!/bin/sh\necho "usage: pm [-h] [--version] <command> ..." >&2\necho "pm: error: unrecognized arguments: --json" >&2\nexit 2\n`,
    { mode: 0o755 },
  );

  const richMessages: any[] = [];
  const server = mkServer('/next HYP-1033', null, richMessages);
  servers.push(server);

  await startDaemon(cfgDir, bin, server.port);

  expect(await waitFor(() => richMessages.length === 1)).toBe(true);
  const html = richMessages[0].rich_message.html as string;
  expect(html).toContain("pm why failed");
  expect(html).not.toContain('no pm work item found');
}, 15_000);

test('/next: a malformed pm why payload (exit 0, wrong shape) degrades to a lookup-failed card, never a thrown error', async () => {
  // Review P1: an unvalidated cast would let this reach composeNextCard's dereferences and throw
  // inside the daemon's per-action loop, which drops every queued action behind it. Proves the
  // daemon sends a normal card instead of silently eating the update.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-next-malformed-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(cfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 1 }));

  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  tmuxStub(bin, projectDir);
  // Every candidate id gets a well-formed-JSON-but-wrong-shape response (missing required fields).
  writeFileSync(join(bin, 'pm'), `#!/bin/sh\nprintf '%s\\n' '{"ok":true}'\nexit 0\n`, { mode: 0o755 });

  const richMessages: any[] = [];
  const server = mkServer('/next HYP-1033', null, richMessages);
  servers.push(server);

  await startDaemon(cfgDir, bin, server.port);

  expect(await waitFor(() => richMessages.length === 1)).toBe(true);
  const html = richMessages[0].rich_message.html as string;
  expect(html).toContain("pm why failed");
}, 15_000);

test('/next: a non-string `project` (fed to matchWindows by the DAEMON, not the renderer) is rejected before it can crash the batch', async () => {
  // Review round 2 P1: the first-pass validator checked every field composeNextCard
  // dereferences but missed `project` — unused by the renderer, but resolveNextScopeDir feeds it
  // straight into agent-match.ts's matchWindows (a `.toLowerCase()` call) BEFORE any card is
  // composed. Two actions land in the SAME getUpdates batch (a malformed /next, then /status) to
  // prove the fix concretely: if the daemon threw mid-batch, /status would never get a reply —
  // dispatch is strictly sequential (tg-ctl's own comment on the action loop).
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-next-badproject-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(cfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 1 }));

  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  tmuxStub(bin, projectDir);
  const badPayload = JSON.stringify({
    id: 'w1', title: 't', state: 'seen', project: 123,
    pm_labels: [], evidence: [], errors: [],
    next: { terminal: false, unknown_state: false, moves: [] },
  });
  writeFileSync(join(bin, 'pm'), `#!/bin/sh\nprintf '%s\\n' '${badPayload}'\nexit 0\n`, { mode: 0o755 });

  const richMessages: any[] = [];
  const plainMessages: any[] = [];
  let served = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!served) {
          served = true;
          const now = Math.floor(Date.now() / 1000);
          return Response.json({
            ok: true,
            result: [
              { update_id: 950, message: { message_id: 30, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: now, text: '/next w1' } },
              { update_id: 951, message: { message_id: 31, from: { id: 1, first_name: 'Alex' }, chat: { id: 1 }, date: now, text: '/status' } },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        richMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 91 } });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        plainMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 92 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
  servers.push(server);

  await startDaemon(cfgDir, bin, server.port);

  // The malformed /next degrades to a lookup-failed card (parsePmWhyJson rejected it)...
  expect(await waitFor(() => richMessages.length === 1)).toBe(true);
  expect(richMessages[0].rich_message.html).toContain("pm why failed");
  // ...AND the /status queued right behind it in the SAME batch still got its own reply — proof
  // the daemon never threw mid-batch.
  expect(await waitFor(() => plainMessages.length >= 1)).toBe(true);
}, 15_000);

test('/next with no ticket id replies with usage text, carrying the SAME reply context a real lookup would use', async () => {
  // Review P2: the old `{kind:'reply'}` escape hatch had no thread/reply fields, so a bare
  // `/next` sent as a reply (or inside a bound topic) lost that context. Proves reply_parameters
  // survives the missing-ticket-id path — the strongest signal available without standing up a
  // full forum-topic fixture.
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-next-usage-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectDir = join(cfgDir, 'project');
  mkdirSync(projectDir);
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 1 }));

  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  tmuxStub(bin, projectDir);

  const sentMessages: any[] = [];
  let served = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!served) {
          served = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 901,
                message: {
                  message_id: 20,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/next',
                  reply_to_message: { message_id: 77 },
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        sentMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 90 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
  servers.push(server);

  await startDaemon(cfgDir, bin, server.port);

  expect(await waitFor(() => sentMessages.length === 1)).toBe(true);
  expect(sentMessages[0].text).toBe('usage: /next <ticket-id>');
  expect(sentMessages[0].reply_parameters).toEqual({ message_id: 77 });
}, 15_000);

test('/next in a bound forum topic sends the card WITH message_thread_id set (mirrors /tasks in a bound topic)', async () => {
  // Review finding (k3, tg-cli#289 round 2): `/next` was added to TOPIC_GLOBAL_CMDS
  // (updates.ts) and threadId flows through to sendRich/sendMessage — but nothing exercised
  // that chain end to end. Without this, a later regression (e.g. someone drops '/next' from
  // TOPIC_GLOBAL_CMDS) has NO test failure — `/next` typed inside a bound topic would then be
  // injected verbatim into the topic agent's own prompt instead of running as a daemon command,
  // and any reply would land in General. Mirrors ctl-tasks-integration.test.ts's own
  // "/tasks in a bound topic" fixture (topics: true, a bound topics.json entry, is_topic_message).
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-next-topic-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n  topics: true\n');
  const projectDir = join(cfgDir, 'project');
  const flatDir = join(cfgDir, 'flat-project');
  mkdirSync(projectDir);
  mkdirSync(flatDir);
  initGitRepo(projectDir);
  // The topic's own bound `path` — NOT the flat registration — is what must resolve, proving the
  // topic anchor (not some other fallback) drove scope resolution.
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: flatDir, registeredAt: 2 }));
  writeFileSync(join(cfgDir, 'tg-ctl.123.topics.json'), JSON.stringify([{ threadId: 123, name: 'Ticket ops', status: 'bound', paneId: '%1', path: projectDir, ts: 1 }]));

  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf "111 1 claude\\n"\n', { mode: 0o755 });
  const pmLog = join(cfgDir, 'pm-invocation.txt');
  pmStub(bin, pmLog, {
    'task:HYP:HYP-1033': {
      exitCode: 0,
      stdout: JSON.stringify({
        id: 'task:HYP:HYP-1033', title: 'Topic-scoped ticket', state: 'seen', project: 'HYP',
        pm_labels: ['pm.stage:intake'], evidence: [], errors: [],
        next: { terminal: false, unknown_state: false, moves: [] },
      }),
    },
  });
  const ghLog = join(cfgDir, 'gh-invocation.txt');
  ghStub(bin, ghLog, '[]');

  const richMessages: any[] = [];
  let served = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!served) {
          served = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 960,
                message: {
                  message_id: 40,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  message_thread_id: 123,
                  is_topic_message: true,
                  date: Math.floor(Date.now() / 1000),
                  text: '/next HYP-1033',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        richMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 93 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
  servers.push(server);

  await startDaemon(cfgDir, bin, server.port);

  expect(await waitFor(() => richMessages.length === 1)).toBe(true);
  expect(richMessages[0].message_thread_id).toBe(123); // the card stays IN the topic, not General
  expect(richMessages[0].rich_message.html).toContain('Topic-scoped ticket');
  expect(readFileSync(pmLog, 'utf8')).toContain('why task:HYP:HYP-1033 --json');
  // the topic's OWN bound path resolved scope — the flat registration's cwd (flatDir) did not.
  expect(readFileSync(ghLog, 'utf8').split('|')[0]).toBe(realpathSync(projectDir));
}, 15_000);

import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons, spawnDaemon } from './helpers/daemon-lifecycle';

// Integration tests for the /tasks bot command's two error paths (review round 1
// on tg-cli#129, chatgpt-codex-connector P2s): an agent selector that matches NO
// live pane must NOT silently scope to the daemon's own cwd, and a failing
// `task list` must NOT be indistinguishable from a genuinely empty backlog.
// Both used to render the same "No matching tasks." board either way.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

function makeCfgDir(prefix: string): string {
  const cfgDir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));
  return cfgDir;
}

function mockUpdatesAndCapture(text: string) {
  let served = false;
  const richMessages: any[] = [];
  const sentMessages: any[] = [];
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
                update_id: 300,
                message: {
                  message_id: 10,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text,
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
        return Response.json({ ok: true, result: { message_id: 88 } });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        sentMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 77 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
  return { server, richMessages, sentMessages };
}

const reg = createDaemonRegistry();

afterAll(async () => {
  await reapDaemons(reg);
});

test('/tasks <agent> with no matching live pane → error reply, never a fake board, never spawns task/gh', async () => {
  const cfgDir = makeCfgDir('tgctl-tasks-nomatch-');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  // No live tmux panes at all → 0 agent candidates → any selector is a non-match.
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Marker stubs: if runTasksCommand incorrectly proceeded past the noMatch
  // guard, these would run and leave a marker file — proves loadTasks/loadPrRefs
  // are never invoked on this path (review round 2 ask).
  const taskMarker = join(cfgDir, 'task-was-invoked');
  const ghMarker = join(cfgDir, 'gh-was-invoked');
  writeFileSync(join(bin, 'task'), `#!/bin/sh\ntouch "${taskMarker}"\necho "[]"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ntouch "${ghMarker}"\necho "[]"\n`, { mode: 0o755 });

  const { server, richMessages, sentMessages } = mockUpdatesAndCapture('/tasks nosuchagent');
  try {
    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && sentMessages.length === 0) await Bun.sleep(50);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text as string).toMatch(/no agent matching ['"]?nosuchagent['"]?/i);
    expect(richMessages).toHaveLength(0);
    expect(existsSync(taskMarker)).toBe(false);
    expect(existsSync(ghMarker)).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("/tasks with a failing 'task list' → error reply, not an empty board", async () => {
  const cfgDir = makeCfgDir('tgctl-tasks-failload-');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'task'), '#!/bin/sh\necho "task-cli: backend unreachable" >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });

  const { server, richMessages, sentMessages } = mockUpdatesAndCapture('/tasks');
  try {
    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && sentMessages.length === 0) await Bun.sleep(50);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text as string).toMatch(/couldn't load tasks/i);
    expect(sentMessages[0].text as string).toMatch(/task-cli: backend unreachable/);
    expect(richMessages).toHaveLength(0);
  } finally {
    server.stop(true);
  }
});

test("/tasks with a genuinely empty backlog (blank stdout, exit 0) → the board, not an error", async () => {
  const cfgDir = makeCfgDir('tgctl-tasks-emptyok-');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Blank stdout on success — distinct from the "[]" happy path already covered
  // by ctl-tasks-integration.test.ts, and from the exitCode!==1 failure above.
  writeFileSync(join(bin, 'task'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });

  const { server, richMessages, sentMessages } = mockUpdatesAndCapture('/tasks');
  try {
    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && richMessages.length === 0 && sentMessages.length === 0) await Bun.sleep(50);

    expect(sentMessages).toHaveLength(0);
    expect(richMessages).toHaveLength(1);
    expect(richMessages[0].rich_message.html as string).toContain('No matching tasks.');
  } finally {
    server.stop(true);
  }
});

test("/tasks with 'task list' returning non-array JSON → error reply, not an empty board", async () => {
  const cfgDir = makeCfgDir('tgctl-tasks-nonarray-');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'task'), '#!/bin/sh\necho \'{"error":"unexpected shape"}\'\n', { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });

  const { server, richMessages, sentMessages } = mockUpdatesAndCapture('/tasks');
  try {
    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && sentMessages.length === 0) await Bun.sleep(50);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text as string).toMatch(/couldn't load tasks/i);
    expect(sentMessages[0].text as string).toMatch(/non-array JSON/);
    expect(richMessages).toHaveLength(0);
  } finally {
    server.stop(true);
  }
});

test("/tasks with 'task list' returning malformed JSON → error reply, not an empty board", async () => {
  const cfgDir = makeCfgDir('tgctl-tasks-badjson-');
  const bin = join(cfgDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'task'), '#!/bin/sh\necho \'{not json\'\n', { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });

  const { server, richMessages, sentMessages } = mockUpdatesAndCapture('/tasks');
  try {
    const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
    await spawnDaemon(reg, {
      tgCtlPath: TG_CTL,
      cfgDir,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: cfgDir,
        TG_CTL_CONFIG_DIR: cfgDir,
        TG_API_BASE: `http://127.0.0.1:${server.port}`,
      },
      logFd,
    });
    closeSync(logFd);

    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && sentMessages.length === 0) await Bun.sleep(50);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text as string).toMatch(/couldn't load tasks/i);
    expect(sentMessages[0].text as string).toMatch(/malformed JSON/);
    expect(richMessages).toHaveLength(0);
  } finally {
    server.stop(true);
  }
});

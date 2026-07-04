import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

// Integration test for the /tasks bot command (tg-cli#115) against a fake Bot
// API, with stub `task` and `gh` binaries on PATH. Proves the daemon composes
// task-cli + gh into a rich-HTML table and sends it via sendRichMessage, with
// PR/CI columns filled from gh and a dash where a ticket has no PR.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-'));
writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
writeFileSync(join(cfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
const projectDir = join(cfgDir, 'project');
mkdirSync(projectDir);
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: projectDir, registeredAt: 2 }));

const bin = join(cfgDir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const taskInvocationLog = join(cfgDir, 'task-invocation.txt');
const ghInvocationLog = join(cfgDir, 'gh-invocation.txt');
// Stub task-cli: two tickets, one with a due date.
const tasksJson = JSON.stringify([
  { id: '#117', title: 'A ticket', state: 'todo', url: 'https://gh/117', due: '' },
  { id: '#5', title: 'Older ticket', state: 'in-progress', url: 'https://gh/5', due: '2026-07-10' },
]);
writeFileSync(join(bin, 'task'), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${taskInvocationLog}'\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
// Stub gh: one PR referencing #117 with a failing check; #5 has none.
const prsJson = JSON.stringify([
  {
    number: 200,
    title: 'fix thing (#117)',
    url: 'https://gh/pr/200',
    body: 'Closes #117',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
  },
]);
writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${ghInvocationLog}'\ncat <<'JSON'\n${prsJson}\nJSON\n`, { mode: 0o755 });

let served = false;
const richMessages: any[] = [];
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
                text: '/tasks',
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
    return Response.json({ ok: true, result: {} });
  },
});

const procs: Subprocess[] = [];
afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  server.stop(true);
});

test('/tasks composes task-cli + gh into a rich-HTML table via sendRichMessage', async () => {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: cfgDir,
      TG_CTL_CONFIG_DIR: cfgDir,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
    },
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(daemon);
  closeSync(logFd);

  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && richMessages.length === 0) await Bun.sleep(50);

  expect(richMessages).toHaveLength(1);
  const html = richMessages[0].rich_message.html as string;
  expect(html).toContain('<table>');
  // ticket ids linked
  expect(html).toContain('href="https://gh/117"');
  expect(html).toContain('#117');
  // PR column filled for #117, CI shows the failing glyph
  expect(html).toContain('href="https://gh/pr/200"');
  expect(html).toContain('✗');
  // #5 has a due date and NO pr → an em dash somewhere
  expect(html).toContain('2026-07-10');
  expect(html).toContain('—');
  expect(readFileSync(taskInvocationLog, 'utf8')).toContain(`-C ${projectDir}`);
  expect(readFileSync(ghInvocationLog, 'utf8').split('|')[0]).toBe(realpathSync(projectDir));
});

test('/tasks without selector follows the same last-message bind and uses matching registration when tmux has no path', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-route-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const routedDir = join(localCfgDir, 'routed-project');
  const newestDir = join(localCfgDir, 'newest-registration');
  mkdirSync(routedDir);
  mkdirSync(newestDir);
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify([
      { paneId: '%1', cwd: routedDir, registeredAt: 1 },
      { paneId: '%2', cwd: newestDir, registeredAt: 2 },
    ]),
  );
  writeFileSync(join(localCfgDir, 'tg-ctl.123.routes.json'), JSON.stringify([{ id: 77, paneId: '%1', cwd: routedDir, ts: 1 }]));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(
    join(localBin, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'routed' '' ''
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%2' '222' 'zsh' 'newest' '' '${newestDir}'
    ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n222 1 claude\\n'\n", { mode: 0o755 });

  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localTaskInvocationLog}'\nprintf '[{\"id\":\"#9\",\"title\":\"Route task\",\"state\":\"todo\",\"url\":\"\",\"due\":\"\"}]\\n'\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(localBin, 'gh'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localGhInvocationLog}'\nprintf '[]\\n'\n`,
    { mode: 0o755 },
  );

  let servedLocal = false;
  const localRichMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 301,
                message: {
                  message_id: 11,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 89 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    const logFd = openSync(join(localCfgDir, 'daemon.log'), 'a');
    daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
      env: {
        PATH: `${localBin}:${process.env.PATH ?? ''}`,
        HOME: localCfgDir,
        TG_CTL_CONFIG_DIR: localCfgDir,
        TG_API_BASE: `http://127.0.0.1:${localServer.port}`,
      },
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);

    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && localRichMessages.length === 0) await Bun.sleep(50);

    expect(localRichMessages).toHaveLength(1);
    expect(readFileSync(localTaskInvocationLog, 'utf8')).toContain(`-C ${routedDir}`);
    expect(readFileSync(localTaskInvocationLog, 'utf8')).not.toContain(`-C ${newestDir}`);
    expect(readFileSync(localGhInvocationLog, 'utf8').split('|')[0]).toBe(realpathSync(routedDir));
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
});

test('/tasks reply scopes to the replied-to agent instead of the latest sender', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-reply-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const repliedDir = join(localCfgDir, 'replied-project');
  const latestDir = join(localCfgDir, 'latest-project');
  mkdirSync(repliedDir);
  mkdirSync(latestDir);
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify([
      { paneId: '%1', cwd: repliedDir, registeredAt: 1 },
      { paneId: '%2', cwd: latestDir, registeredAt: 2 },
    ]),
  );
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.routes.json'),
    JSON.stringify([
      { id: 77, paneId: '%1', cwd: repliedDir, ts: 1 },
      { id: 88, paneId: '%2', cwd: latestDir, ts: 2 },
    ]),
  );

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(
    join(localBin, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'replied' '' '${repliedDir}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%2' '222' 'zsh' 'latest' '' '${latestDir}'
    ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n222 1 claude\\n'\n", { mode: 0o755 });

  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localTaskInvocationLog}'\nprintf '[{\"id\":\"#10\",\"title\":\"Reply task\",\"state\":\"todo\",\"url\":\"\",\"due\":\"\"}]\\n'\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(localBin, 'gh'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localGhInvocationLog}'\nprintf '[]\\n'\n`,
    { mode: 0o755 },
  );

  let servedLocal = false;
  const localRichMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 302,
                message: {
                  message_id: 12,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                  reply_to_message: { message_id: 77 },
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 92 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    const logFd = openSync(join(localCfgDir, 'daemon.log'), 'a');
    daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
      env: {
        PATH: `${localBin}:${process.env.PATH ?? ''}`,
        HOME: localCfgDir,
        TG_CTL_CONFIG_DIR: localCfgDir,
        TG_API_BASE: `http://127.0.0.1:${localServer.port}`,
      },
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);

    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && localRichMessages.length === 0) await Bun.sleep(50);

    expect(localRichMessages).toHaveLength(1);
    expect(readFileSync(localTaskInvocationLog, 'utf8')).toContain(`-C ${repliedDir}`);
    expect(readFileSync(localTaskInvocationLog, 'utf8')).not.toContain(`-C ${latestDir}`);
    expect(readFileSync(localGhInvocationLog, 'utf8').split('|')[0]).toBe(realpathSync(repliedDir));
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
});

test('/tasks <agent> uses matching registration when tmux has no path', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-agent-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const agentDir = join(localCfgDir, 'agent-project');
  mkdirSync(agentDir);
  writeFileSync(join(localCfgDir, 'tg-ctl.123.registration.json'), JSON.stringify([{ paneId: '%1', cwd: agentDir, registeredAt: 1 }]));

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(
    join(localBin, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'routed' '' '' ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n'\n", { mode: 0o755 });

  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  writeFileSync(
    join(localBin, 'task'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localTaskInvocationLog}'\nprintf '[{\"id\":\"#11\",\"title\":\"Agent task\",\"state\":\"todo\",\"url\":\"\",\"due\":\"\"}]\\n'\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(localBin, 'gh'),
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" > '${localGhInvocationLog}'\nprintf '[]\\n'\n`,
    { mode: 0o755 },
  );

  let servedLocal = false;
  const localRichMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 303,
                message: {
                  message_id: 13,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks routed',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 93 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    const logFd = openSync(join(localCfgDir, 'daemon.log'), 'a');
    daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
      env: {
        PATH: `${localBin}:${process.env.PATH ?? ''}`,
        HOME: localCfgDir,
        TG_CTL_CONFIG_DIR: localCfgDir,
        TG_API_BASE: `http://127.0.0.1:${localServer.port}`,
      },
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);

    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && localRichMessages.length === 0) await Bun.sleep(50);

    expect(localRichMessages).toHaveLength(1);
    expect(readFileSync(localTaskInvocationLog, 'utf8')).toContain(`-C ${agentDir}`);
    expect(readFileSync(localGhInvocationLog, 'utf8').split('|')[0]).toBe(realpathSync(agentDir));
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
});

test('/tasks without a resolvable project sends an explicit error instead of running in daemon cwd', async () => {
  const localCfgDir = mkdtempSync(join(tmpdir(), 'tgctl-tasks-noscope-'));
  writeFileSync(join(localCfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  writeFileSync(join(localCfgDir, 'config.yaml'), 'control:\n  enabled: true\n');
  const projectA = join(localCfgDir, 'project-a');
  const projectB = join(localCfgDir, 'project-b');
  mkdirSync(projectA);
  mkdirSync(projectB);
  writeFileSync(
    join(localCfgDir, 'tg-ctl.123.registration.json'),
    JSON.stringify([
      { paneId: '%1', cwd: projectA, registeredAt: 1 },
      { paneId: '%2', cwd: projectB, registeredAt: 2 },
    ]),
  );

  const localBin = join(localCfgDir, 'bin');
  mkdirSync(localBin);
  writeFileSync(
    join(localBin, 'tmux'),
    `#!/bin/sh
case "$1" in
  list-panes)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '0' '%1' '111' 'zsh' 'a' '' '${projectA}'
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 'main' '1' '%2' '222' 'zsh' 'b' '' '${projectB}'
    ;;
  display-message) printf 'main\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(localBin, 'ps'), "#!/bin/sh\nprintf '111 1 claude\\n222 1 claude\\n'\n", { mode: 0o755 });
  const localTaskInvocationLog = join(localCfgDir, 'task-invocation.txt');
  const localGhInvocationLog = join(localCfgDir, 'gh-invocation.txt');
  writeFileSync(join(localBin, 'task'), `#!/bin/sh\nprintf 'ran\\n' > '${localTaskInvocationLog}'\nprintf '[]\\n'\n`, {
    mode: 0o755,
  });
  writeFileSync(join(localBin, 'gh'), `#!/bin/sh\nprintf 'ran\\n' > '${localGhInvocationLog}'\nprintf '[]\\n'\n`, { mode: 0o755 });

  let servedLocal = false;
  const localTextMessages: any[] = [];
  const localRichMessages: any[] = [];
  const localServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        if (!servedLocal) {
          servedLocal = true;
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 302,
                message: {
                  message_id: 12,
                  from: { id: 1, first_name: 'Alex' },
                  chat: { id: 1 },
                  date: Math.floor(Date.now() / 1000),
                  text: '/tasks',
                },
              },
            ],
          });
        }
        await Bun.sleep(80);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        localTextMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 90 } });
      }
      if (url.pathname.endsWith('/sendRichMessage')) {
        localRichMessages.push(await req.json());
        return Response.json({ ok: true, result: { message_id: 91 } });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  let daemon: Subprocess | null = null;
  try {
    const logFd = openSync(join(localCfgDir, 'daemon.log'), 'a');
    daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
      cwd: localCfgDir,
      env: {
        PATH: `${localBin}:${process.env.PATH ?? ''}`,
        HOME: localCfgDir,
        TG_CTL_CONFIG_DIR: localCfgDir,
        TG_API_BASE: `http://127.0.0.1:${localServer.port}`,
      },
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);

    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && localTextMessages.length === 0) await Bun.sleep(50);

    expect(localTextMessages).toHaveLength(1);
    expect(localTextMessages[0].text).toContain("couldn't resolve a project for /tasks");
    expect(localRichMessages).toHaveLength(0);
    expect(existsSync(localTaskInvocationLog)).toBe(false);
    expect(existsSync(localGhInvocationLog)).toBe(false);
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill(9);
      await daemon.exited;
    }
    localServer.stop(true);
  }
});

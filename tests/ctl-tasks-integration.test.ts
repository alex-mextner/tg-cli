import { afterAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'fs';
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
writeFileSync(join(cfgDir, 'tg-ctl.123.registration.json'), JSON.stringify({ cwd: cfgDir }));

const bin = join(cfgDir, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// Stub task-cli: two tickets, one with a due date.
const tasksJson = JSON.stringify([
  { id: '#117', title: 'A ticket', state: 'todo', url: 'https://gh/117', due: '' },
  { id: '#5', title: 'Older ticket', state: 'in-progress', url: 'https://gh/5', due: '2026-07-10' },
]);
writeFileSync(join(bin, 'task'), `#!/bin/sh\ncat <<'JSON'\n${tasksJson}\nJSON\n`, { mode: 0o755 });
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
writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncat <<'JSON'\n${prsJson}\nJSON\n`, { mode: 0o755 });

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
});

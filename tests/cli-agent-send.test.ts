import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { toSansBold } from '../features/prefix-style/style';

// A Latin subagent label is rendered through the SAME Sans-Serif Bold styling as
// [window] (styleWindowName) — the wire-level text carries the styled unicode
// form, not the raw ASCII label. Build the expected bracket the same way
// tests/prefix-style.test.ts does.
const styledBracket = (label: string): string => `[${toSansBold(label)}]`;

// End-to-end SUBAGENT self-label: run the REAL `tg` binary against a mock
// Bot-API server (TG_API_BASE) and assert the wire-level sendMessage text
// carries (or omits) the `[name]` bracket. This is the actual send path a
// subagent would exercise, not just the pure parseArgs/buildPrefix units.
//
// The load-bearing guarantees (post-rename, no env auto-detection):
//   1. `tg --subagent <name>` → sendMessage text contains `[<name>]`.
//   2. The deprecated `--agent <name>` alias behaves identically.
//   3. TG_AGENT env acts as the same-precedence fallback for the flag.
//   4. An explicit flag WINS over TG_AGENT.
//   5. REGRESSION: no flag, no TG_AGENT → NO second bracket — and crucially,
//      the presence of CLAUDE_CODE_CHILD_SESSION does NOT resurrect a guessed
//      `[subagent]` bracket (the old broken auto-detection is gone: that env is
//      not a reliable main-vs-subagent signal).

const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

let sent: Array<Record<string, unknown>>;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/sendMessage')) {
      const body = (await req.json()) as Record<string, unknown>;
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
  },
});

const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A throwaway HOME with a tg-cli config holding fake creds, so `tg` clears its
// credential gate and actually hits our mock.
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tg-agent-home-'));
  dirs.push(home);
  const cfg = join(home, '.config', 'tg-cli');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');
  return home;
}

// MUST be async (Bun.spawn, not spawnSync): the mock server runs on this same
// process's event loop.
async function runSend(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string }> {
  const home = makeHome();
  const proc = Bun.spawn(['bun', TG_SCRIPT, ...args], {
    // Deliberately NOT inheriting process.env: a dev/CI machine running these
    // tests from inside a real Claude Code session would otherwise leak its OWN
    // CLAUDECODE/TMUX into the spawned `tg`. Also NOT passing TMUX, so
    // tmuxWindow resolves to '' → no [window] bracket, isolating the subagent
    // bracket under test.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TG_API_BASE: `http://127.0.0.1:${server.port}`,
      ...extraEnv,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

test('`tg --subagent hyperide-fixer` sends a message carrying "[hyperide-fixer]"', async () => {
  sent = [];
  const { exitCode } = await runSend(['--subagent', 'hyperide-fixer', 'status update']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('hyperide-fixer'));
  expect(sent[0].text as string).toContain('status update');
});

test('the deprecated `--agent <name>` alias renders the same bracket', async () => {
  sent = [];
  const { exitCode } = await runSend(['--agent', 'legacy-caller', 'body']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('legacy-caller'));
});

test('TG_AGENT env is honored like --subagent when the flag is absent', async () => {
  sent = [];
  const { exitCode } = await runSend(['env-labeled message'], { TG_AGENT: 'env-named' });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('env-named'));
});

test('an explicit --subagent WINS over TG_AGENT env', async () => {
  sent = [];
  const { exitCode } = await runSend(['--subagent', 'flag-over-env', 'body'], {
    TG_AGENT: 'env-loses',
  });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('flag-over-env'));
  expect(sent[0].text as string).not.toContain(styledBracket('env-loses'));
});

test('REGRESSION: no flag, no TG_AGENT → no second bracket (1:1 path unchanged)', async () => {
  sent = [];
  const { exitCode } = await runSend(['plain top-level message']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).not.toContain(styledBracket('subagent'));
});

// The exact regression Alex reported: a session where CLAUDE_CODE_CHILD_SESSION
// is present (it is NOT a reliable main-vs-subagent signal) must NOT get a
// guessed `[subagent]` bracket. The old env auto-detection produced that; it is
// gone. Only an explicit flag/TG_AGENT labels a subagent now.
test('CLAUDE_CODE_CHILD_SESSION present but no flag → NO guessed [subagent] bracket', async () => {
  sent = [];
  const { exitCode } = await runSend(['from some claude context'], {
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
  });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).not.toContain(styledBracket('subagent'));
});

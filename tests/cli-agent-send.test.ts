import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { toSansBold } from '../features/prefix-style/style';

// A Latin agent label is rendered through the SAME Sans-Serif Bold styling as
// [window] (styleWindowName) — the wire-level text carries the styled unicode
// form, not the raw ASCII label. Build the expected bracket the same way
// tests/prefix-style.test.ts does.
const styledBracket = (label: string): string => `[${toSansBold(label)}]`;

// End-to-end subagent identification (tg#6254): run the REAL `tg` binary
// against a mock Bot-API server (TG_API_BASE) and assert the wire-level
// sendMessage text carries (or omits) the `[agent]` bracket. This is the
// actual send path an orchestrator/subagent would exercise, not just the pure
// parseArgs/buildPrefix units (covered separately).
//
// The load-bearing guarantees:
//   1. `tg --agent <name>` → sendMessage text contains `[<name>]`.
//   2. CLAUDE_CODE_CHILD_SESSION env (no --agent) → auto-detects `[subagent]`.
//   3. An explicit --agent WINS over the env auto-detection.
//   4. REGRESSION: no --agent and no Claude Code child-session env → NO agent
//      bracket at all (the 1:1 path stays byte-identical).

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
    // tests from inside a real Claude Code session would otherwise leak its
    // OWN CLAUDECODE/CLAUDE_CODE_CHILD_SESSION into the spawned `tg`, making
    // the "no auto-detection" regression case flaky depending on who runs it.
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

test('`tg --agent hyperide-fixer` sends a message carrying "[hyperide-fixer]"', async () => {
  sent = [];
  const { exitCode } = await runSend(['--agent', 'hyperide-fixer', 'status update']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('hyperide-fixer'));
  expect(sent[0].text as string).toContain('status update');
});

test('CLAUDE_CODE_CHILD_SESSION env auto-detects "[subagent]" when --agent is absent', async () => {
  sent = [];
  const { exitCode } = await runSend(['from a subagent'], {
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
  });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('subagent'));
});

test('an explicit --agent WINS over the Claude Code child-session auto-detection', async () => {
  sent = [];
  const { exitCode } = await runSend(['--agent', 'named-explicitly', 'body'], {
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
  });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('named-explicitly'));
  expect(sent[0].text as string).not.toContain(styledBracket('subagent'));
});

test('REGRESSION: no --agent, no child-session env → no agent bracket at all (1:1 path unchanged)', async () => {
  sent = [];
  const { exitCode } = await runSend(['plain top-level message']);
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  // A top-level Claude Code session (CLAUDECODE set, but no
  // CLAUDE_CODE_CHILD_SESSION) must NOT get an agent bracket either — the
  // signal only fires for an actual subagent, never the orchestrator itself.
  const text = sent[0].text as string;
  expect(text).not.toContain(styledBracket('subagent'));
});

test('a Claude Code TOP-LEVEL session (no child-session flag) gets no agent bracket', async () => {
  sent = [];
  const { exitCode } = await runSend(['top-level send'], { CLAUDECODE: '1' });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).not.toContain(styledBracket('subagent'));
});

test('TG_AGENT env is honored like --agent when the flag is absent', async () => {
  sent = [];
  const { exitCode } = await runSend(['env-labeled message'], { TG_AGENT: 'env-named' });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('env-named'));
});

// Full priority-chain coverage (review finding, tg#6254): flag > TG_AGENT env >
// Claude Code child-session auto-detection > nothing. The two tests above
// prove flag-vs-auto-detect and env-vs-nothing separately; these two close the
// remaining two links in the chain.
test('TG_AGENT env WINS over the Claude Code child-session auto-detection', async () => {
  sent = [];
  const { exitCode } = await runSend(['from env, not auto'], {
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    TG_AGENT: 'env-over-auto',
  });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('env-over-auto'));
  expect(sent[0].text as string).not.toContain(styledBracket('subagent'));
});

test('a whitespace-only TG_AGENT falls through to Claude Code auto-detection (not an empty bracket)', async () => {
  sent = [];
  const { exitCode } = await runSend(['padded env, ignored'], {
    TG_AGENT: '   ',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
  });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('subagent'));
});

test('an explicit --agent WINS over TG_AGENT env', async () => {
  sent = [];
  const { exitCode } = await runSend(['--agent', 'flag-over-env', 'body'], {
    TG_AGENT: 'env-loses',
  });
  expect(exitCode).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].text as string).toContain(styledBracket('flag-over-env'));
  expect(sent[0].text as string).not.toContain(styledBracket('env-loses'));
});

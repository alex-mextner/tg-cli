import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildKeyInjectPlan, buildTextInjectPlan } from '../features/tg-ctl/inject';
import type { InjectStep } from '../features/tg-ctl/types';

// Real-tmux integration (spec §11): InjectStep plans executed against a live
// tmux pane running a readline stub. Everything runs on a THROWAWAY socket
// (-L tgctl-test-<pid>) so the user's real tmux server is never touched; the
// §2 capture-pane ban applies to the production round-trip only — tests may
// use it for assertions.

const SOCKET = `tgctl-test-${process.pid}`;

// Env without TMUX: tmux refuses new-session from inside another tmux
// ("sessions should be nested with care") even on a different socket.
const tmuxEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k !== 'TMUX' && v !== undefined) tmuxEnv[k] = v;
}

let tmuxAvailable = false;
try {
  tmuxAvailable = Bun.spawnSync(['tmux', '-V'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
} catch {
  // no tmux binary at all
}

function tmux(args: string[], stdin?: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['tmux', '-L', SOCKET, ...args], {
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    env: tmuxEnv,
  });
  return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// Same executor shape as tg-ctl's (module-private) executeInjectSteps, with
// two test-bench substitutions: the throwaway -L socket is spliced into every
// argv, and verify-pane checks pane existence on that socket (the real one
// requires an agent process, which the stub deliberately is not).
async function executeSteps(steps: InjectStep[]): Promise<void> {
  for (const step of steps) {
    if (step.kind === 'verify-pane') {
      const list = tmux(['list-panes', '-a', '-F', '#{pane_id}']);
      expect(list.stdout.split('\n')).toContain(step.paneId);
    } else if (step.kind === 'tmux') {
      expect(step.argv[0]).toBe('tmux'); // plans must target tmux, nothing else
      const r = tmux(step.argv.slice(1), step.stdin);
      if (r.exitCode !== 0) {
        throw new Error(`${step.argv.join(' ')} failed (${r.exitCode}): ${r.stderr.trim()}`);
      }
    } else {
      await Bun.sleep(step.ms);
    }
  }
}

// The "agent": prints READY, then echoes GOT:<line> per submitted line. Echoed
// keystrokes never start with "GOT:", so GOT-lines count submissions exactly.
const stubDir = mkdtempSync(join(tmpdir(), 'tgctl-tmux-'));
const stubPath = join(stubDir, 'stub.ts');
writeFileSync(stubPath, "console.log('READY');\nfor await (const line of console) console.log(`GOT:${line}`);\n");

function capture(paneId: string): string {
  return tmux(['capture-pane', '-p', '-t', paneId]).stdout;
}

async function waitForCapture(
  paneId: string,
  pred: (out: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const out = capture(paneId);
    if (pred(out)) return out;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`capture-pane condition not met in ${timeoutMs}ms; last capture:\n${out}`);
    }
    await Bun.sleep(100);
  }
}

const gotLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('GOT:'));

// One session per test: a leftover ESC byte or pending line buffer in a shared
// pane would leak between tests. kill-server reaps them all.
async function newStubPane(name: string): Promise<string> {
  const r = tmux([
    'new-session', '-d', '-P', '-F', '#{pane_id}',
    '-s', name, '-x', '80', '-y', '24',
    `"${process.execPath}" "${stubPath}"`,
  ]);
  expect(r.exitCode).toBe(0);
  const paneId = r.stdout.trim();
  await waitForCapture(paneId, (out) => out.includes('READY'));
  return paneId;
}

afterAll(() => {
  if (tmuxAvailable) tmux(['kill-server']); // throwaway socket only
});

test.skipIf(!tmuxAvailable)('single-line plan lands as exactly one submission', async () => {
  const paneId = await newStubPane('single');
  await executeSteps(buildTextInjectPlan(paneId, 'hello from telegram'));
  const out = await waitForCapture(paneId, (o) => o.includes('GOT:hello from telegram'));
  expect(gotLines(out)).toEqual(['GOT:hello from telegram']);
}, 15_000);

test.skipIf(!tmuxAvailable)('3-line plan arrives complete via buffer paste + single Enter', async () => {
  const paneId = await newStubPane('multi');
  await executeSteps(buildTextInjectPlan(paneId, 'alpha\nbeta\ngamma'));
  // The last line has no trailing newline in the paste — it can only have been
  // submitted by the plan's single separate Enter. Substring matching, not
  // line-anchored: the tty echo of the pasted "gamma" leaves the cursor
  // mid-line, so the stub's first output can land glued to it
  // ("gammaGOT:alpha"). The pasted text itself never contains "GOT:", so
  // counting the marker still counts submissions exactly.
  await waitForCapture(paneId, (o) =>
    ['GOT:alpha', 'GOT:beta', 'GOT:gamma'].every((l) => o.includes(l)),
  );
  await Bun.sleep(250); // settle — a late duplicate submission must not escape the count
  const out = capture(paneId);
  expect(out.split('GOT:')).toHaveLength(4); // exactly 3 markers
}, 15_000);

test.skipIf(!tmuxAvailable)('Escape verb produces no submission', async () => {
  const paneId = await newStubPane('escape');
  await executeSteps(buildKeyInjectPlan(paneId, 'Escape'));
  await Bun.sleep(400); // give a wrong submission time to surface
  expect(gotLines(capture(paneId))).toEqual([]);
}, 15_000);

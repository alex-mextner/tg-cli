// Unit tests for features/tg-ctl/rig-delegate.ts — the shared "is rig here? then let rig own
// the hooks" decision (tg#8672), reached via `python3 -m agenttools_rig_delegate ...` (agent-tools
// PR #282). These build a MINIMAL fake `agenttools_rig_delegate` package under a throwaway
// checkout (not the real agent-tools repo — the CLI contract is small and stable: `detect` exits
// 0/1, `delegate [ARGS...]` runs `rig <ARGS...>` and exits with rig's code, or 3 (NO_RIG_EXIT) if
// rig is absent) so the test never depends on a real agent-tools checkout being present on disk.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectRig, resolveAgentToolsLib, runRigDelegate } from '../features/tg-ctl/rig-delegate';

// A PATH containing ONLY python3's own directory — deliberately excludes wherever a real `rig`
// might be installed on the dev machine (this machine has one), so "rig absent" tests are not
// accidentally polluted by a real system install.
const PYTHON3_ONLY_PATH = require('path').dirname(Bun.which('python3') ?? '/usr/bin/python3');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tgctl-rig-delegate-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Writes a fake agent-tools checkout at <root>/agent-tools/lib/agenttools_rig_delegate that mirrors
// the real CLI's detect/delegate contract, backed by a fake `rig` binary that records its argv.
function fakeAgentToolsCheckout(opts: { rigOnPath: boolean; rigExitCode?: number }): { source: string; rigLog: string; binDir: string } {
  const source = join(root, 'agent-tools');
  const pkgDir = join(source, 'lib', 'agenttools_rig_delegate');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, '__init__.py'), '');
  const binDir = join(root, 'bin');
  const rigLog = join(root, 'rig.log');
  mkdirSync(binDir, { recursive: true });
  if (opts.rigOnPath) {
    const rigBin = join(binDir, 'rig');
    writeFileSync(
      rigBin,
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(rigLog)}\nexit ${opts.rigExitCode ?? 0}\n`,
    );
    chmodSync(rigBin, 0o755);
  }
  writeFileSync(
    join(pkgDir, '__main__.py'),
    [
      'import os, shutil, subprocess, sys',
      'NO_RIG_EXIT = 3',
      'def find_rig():',
      '    return shutil.which("rig")',
      'def main():',
      '    args = sys.argv[1:]',
      '    if not args:',
      '        return 2',
      '    cmd, rest = args[0], args[1:]',
      '    if cmd == "detect":',
      '        rig = find_rig()',
      '        if rig is None:',
      '            return 1',
      '        print(rig)',
      '        return 0',
      '    if cmd == "delegate":',
      '        rig = find_rig()',
      '        if rig is None:',
      '            return NO_RIG_EXIT',
      '        return subprocess.run([rig, *rest]).returncode',
      '    return 2',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
    ].join('\n'),
  );
  return { source, rigLog, binDir };
}

test('resolveAgentToolsLib: finds the lib dir via RIG_AGENT_TOOLS_SOURCE', () => {
  const { source } = fakeAgentToolsCheckout({ rigOnPath: false });
  const lib = resolveAgentToolsLib({ RIG_AGENT_TOOLS_SOURCE: source });
  expect(lib).toBe(join(source, 'lib'));
});

test('resolveAgentToolsLib: null when nothing resolves', () => {
  const lib = resolveAgentToolsLib({ RIG_AGENT_TOOLS_SOURCE: join(root, 'nope') });
  expect(lib).toBeNull();
});

test('detectRig: absent when the agent-tools checkout cannot be found (no PYTHONPATH target)', () => {
  const result = detectRig({ RIG_AGENT_TOOLS_SOURCE: join(root, 'nope'), PATH: PYTHON3_ONLY_PATH });
  expect(result.present).toBe(false);
});

test('detectRig: absent when the package resolves but `rig` is not on PATH', () => {
  const { source } = fakeAgentToolsCheckout({ rigOnPath: false });
  const result = detectRig({ RIG_AGENT_TOOLS_SOURCE: source, PATH: PYTHON3_ONLY_PATH });
  expect(result.present).toBe(false);
});

test('detectRig: present when both the package and a `rig` binary resolve', () => {
  const { source, binDir } = fakeAgentToolsCheckout({ rigOnPath: true });
  const result = detectRig({ RIG_AGENT_TOOLS_SOURCE: source, PATH: `${binDir}:${PYTHON3_ONLY_PATH}` });
  expect(result.present).toBe(true);
  expect(result.rigPath).toBe(join(binDir, 'rig'));
});

test('runRigDelegate: runs `rig <args>` and reports rig\'s own exit code', () => {
  const { source, binDir, rigLog } = fakeAgentToolsCheckout({ rigOnPath: true, rigExitCode: 0 });
  const result = runRigDelegate(['apply'], { RIG_AGENT_TOOLS_SOURCE: source, PATH: `${binDir}:${PYTHON3_ONLY_PATH}` });
  expect(result.ran).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(require('fs').readFileSync(rigLog, 'utf8').trim()).toBe('apply');
});

test('runRigDelegate: surfaces a non-zero rig exit code without throwing', () => {
  const { source, binDir } = fakeAgentToolsCheckout({ rigOnPath: true, rigExitCode: 7 });
  const result = runRigDelegate(['apply'], { RIG_AGENT_TOOLS_SOURCE: source, PATH: `${binDir}:${PYTHON3_ONLY_PATH}` });
  expect(result.ran).toBe(true);
  expect(result.exitCode).toBe(7);
});

test('runRigDelegate: ran=false when the agent-tools package cannot be resolved', () => {
  const result = runRigDelegate(['apply'], { RIG_AGENT_TOOLS_SOURCE: join(root, 'nope'), PATH: PYTHON3_ONLY_PATH });
  expect(result.ran).toBe(false);
  expect(result.exitCode).toBeNull();
});

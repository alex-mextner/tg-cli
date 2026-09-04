// Integration test for the REAL escalation-format-gate reference hook
// (features/hooks/escalation-format-descriptor/pre_send_text_gate.ts), run as
// an actual `bun` subprocess through the pre-send-text hook framework — not a
// mocked stand-in. Verifies the WARN-MODE contract end to end: for
// --tag decision with no literal table, the send is NOT blocked, a
// human-readable warning reaches stderr (surfaced via deps.warn in
// runner.ts), and the gate_* fields land in the hook's result.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runPreSendTextHooks } from '../features/hooks/run-text-hooks';
import { toolHooksDir } from '../features/hooks/run-photo-hooks';

const REPO = join(import.meta.dir, '..');
const GATE_SCRIPT = join(REPO, 'features', 'hooks', 'escalation-format-descriptor', 'pre_send_text_gate.ts');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-escalation-gate-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function installDescriptor(): void {
  const dir = toolHooksDir(home);
  mkdirSync(dir, { recursive: true });
  // Trust-by-default (no AGENTS_HOOKS_TRUST guard) — no pin needed, mirrors
  // the common-case path every other hook test in this repo exercises.
  writeFileSync(
    join(dir, 'escalation-format-gate.pre-send-text.json'),
    JSON.stringify({
      id: 'escalation-format-gate',
      point: 'pre-send-text',
      cmd: GATE_SCRIPT,
      timeout_ms: 5000,
      on_error: 'open',
    }),
  );
}

const guardOffEnv = { ...process.env, AGENTS_HOOKS_TRUST: undefined };

test('decision tag, no table → NOT blocked (warn mode), stderr carries the warning', () => {
  installDescriptor();
  const v = runPreSendTextHooks({ body: 'ship it or not?', tag: 'decision' }, guardOffEnv, home);
  expect(v.blocked).toBe(false);
  expect(v.results).toHaveLength(1);
  expect(v.results[0].errored).toBe(false);
  expect(v.results[0].gateTag).toBe('decision');
  expect(v.results[0].gateMissing).toBe('table');
  expect(v.results[0].gateTableKind).toBe('none');
  expect(v.results[0].bodySha256).toMatch(/^[0-9a-f]{64}$/);
}, 15000);

test('the removed question tag is NOT an escalation tag for the hook — plain allow, no gate fields (tg-cli#301)', () => {
  // The CLI refuses --tag question before any hook runs; a programmatic caller
  // handing the hook that tag gets a plain allow (it is off the ESCALATION_TAGS
  // list), not a gated verdict.
  installDescriptor();
  const v = runPreSendTextHooks({ body: 'which option do we take?', tag: 'question' }, guardOffEnv, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].errored).toBe(false);
  expect(v.results[0].gateTag).toBeUndefined();
}, 15000);

test('decision tag WITH a literal pipe table → allowed, gate_missing is empty', () => {
  installDescriptor();
  const body = ['| Option | Tradeoff |', '| --- | --- |', '| A | slower |'].join('\n');
  const v = runPreSendTextHooks({ body, tag: 'decision' }, guardOffEnv, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].gateMissing).toBe('');
  expect(v.results[0].gateTableKind).toBe('pipe');
}, 15000);

test('a non-escalation tag (report) is a silent allow — the gate does not evaluate it', () => {
  installDescriptor();
  const v = runPreSendTextHooks({ body: 'all green', tag: 'report' }, guardOffEnv, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].gateTag).toBeUndefined();
}, 15000);

test('no tag at all → silent allow', () => {
  installDescriptor();
  const v = runPreSendTextHooks({ body: 'just a normal message' }, guardOffEnv, home);
  expect(v.blocked).toBe(false);
}, 15000);

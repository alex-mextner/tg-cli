import { expect, test } from 'bun:test';
import { withClaudeHooks, claudeHooksInstalled, withHarnessHooks, harnessHooksInstalled } from '../features/tg-ctl/hook-install';

const CMD = 'tg-ctl ask';
const HARNESS_CMD = 'tg-ctl harness-event';

test('empty settings → both hook groups added, changed=true', () => {
  const { settings, changed } = withClaudeHooks({}, CMD);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  // ExitPlanMode (plan-approval) is NOT given its own PreToolUse matcher — it is
  // delivered exactly once by the PermissionRequest `*` catch-all (a dedicated
  // PreToolUse matcher would double-forward it; both events fire for that call).
  expect(hooks.PreToolUse).toEqual([
    { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CMD, timeout: 120 }] },
  ]);
  expect(hooks.PermissionRequest).toEqual([
    { matcher: '*', hooks: [{ type: 'command', command: CMD, timeout: 120 }] },
  ]);
  expect(claudeHooksInstalled(settings, CMD)).toBe(true);
});

test('idempotent: re-running does not duplicate, changed=false', () => {
  const once = withClaudeHooks({}, CMD).settings;
  const twice = withClaudeHooks(once, CMD);
  expect(twice.changed).toBe(false);
  expect((twice.settings.hooks as Record<string, unknown[]>).PreToolUse.length).toBe(1);
});

test('preserves existing unrelated hooks', () => {
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk.sh' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'tg install-skill' }] }],
    },
  };
  const { settings, changed } = withClaudeHooks(existing, CMD);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  // Bash hook still there, AskUserQuestion added alongside
  expect(hooks.PreToolUse.length).toBe(2);
  expect(hooks.PreToolUse[0]).toMatchObject({ matcher: 'Bash' });
  expect(hooks.SessionStart).toEqual(existing.hooks.SessionStart);
});

test('claudeHooksInstalled: false when only one of the two groups present', () => {
  const partial = { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CMD }] }] } };
  expect(claudeHooksInstalled(partial, CMD)).toBe(false); // PermissionRequest missing
});

test('detects a catch-all PermissionRequest with a missing matcher as installed', () => {
  const s = withClaudeHooks({}, CMD).settings;
  // simulate a hand-written group with no matcher (== '*')
  (s.hooks as Record<string, unknown[]>).PermissionRequest = [{ hooks: [{ type: 'command', command: CMD }] }];
  expect(claudeHooksInstalled(s, CMD)).toBe(true);
});

// --- StopFailure harness hook provisioning (#113) ---

test('harness hook: empty settings → StopFailure * group added, changed=true', () => {
  const { settings, changed } = withHarnessHooks({}, HARNESS_CMD);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  expect(hooks.StopFailure).toEqual([
    { matcher: '*', hooks: [{ type: 'command', command: HARNESS_CMD, timeout: 30 }] },
  ]);
  expect(harnessHooksInstalled(settings, HARNESS_CMD)).toBe(true);
});

test('harness hook: idempotent re-run does not duplicate', () => {
  const once = withHarnessHooks({}, HARNESS_CMD).settings;
  const twice = withHarnessHooks(once, HARNESS_CMD);
  expect(twice.changed).toBe(false);
  expect((twice.settings.hooks as Record<string, unknown[]>).StopFailure.length).toBe(1);
});

test('harness hook merges ALONGSIDE the q→buttons hooks without clobbering them', () => {
  const q = withClaudeHooks({}, CMD).settings;
  const { settings } = withHarnessHooks(q, HARNESS_CMD);
  const hooks = settings.hooks as Record<string, unknown[]>;
  // both feature sets present
  expect(claudeHooksInstalled(settings, CMD)).toBe(true);
  expect(harnessHooksInstalled(settings, HARNESS_CMD)).toBe(true);
  expect(hooks.PreToolUse.length).toBe(1);
  expect(hooks.StopFailure.length).toBe(1);
});

test('harnessHooksInstalled: false on empty settings', () => {
  expect(harnessHooksInstalled({}, HARNESS_CMD)).toBe(false);
});

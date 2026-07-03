import { expect, test } from 'bun:test';
import { withClaudeHooks, claudeHooksInstalled, type HookCommands } from '../features/tg-ctl/hook-install';

const CMDS: HookCommands = { ask: 'tg-ctl ask', harnessEvent: 'tg-ctl harness-event' };

test('empty settings → all hook groups added, changed=true', () => {
  const { settings, changed } = withClaudeHooks({}, CMDS);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  // ExitPlanMode (plan-approval) is NOT given its own PreToolUse matcher — it is
  // delivered exactly once by the PermissionRequest `*` catch-all (a dedicated
  // PreToolUse matcher would double-forward it; both events fire for that call).
  expect(hooks.PreToolUse).toEqual([
    { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CMDS.ask, timeout: 120 }] },
  ]);
  expect(hooks.PermissionRequest).toEqual([
    { matcher: '*', hooks: [{ type: 'command', command: CMDS.ask, timeout: 120 }] },
  ]);
  // Limit-stop notify (tg-cli#113): StopFailure fires when a turn dies on a
  // usage limit / API error; the short timeout keeps the hook from holding the
  // harness (it only writes a socket line or one fallback HTTP send).
  expect(hooks.StopFailure).toEqual([
    { matcher: '*', hooks: [{ type: 'command', command: CMDS.harnessEvent, timeout: 30 }] },
  ]);
  expect(claudeHooksInstalled(settings, CMDS)).toBe(true);
});

test('idempotent: re-running does not duplicate, changed=false', () => {
  const once = withClaudeHooks({}, CMDS).settings;
  const twice = withClaudeHooks(once, CMDS);
  expect(twice.changed).toBe(false);
  const hooks = twice.settings.hooks as Record<string, unknown[]>;
  expect(hooks.PreToolUse.length).toBe(1);
  expect(hooks.StopFailure.length).toBe(1);
});

test('preserves existing unrelated hooks', () => {
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk.sh' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'tg install-skill' }] }],
    },
  };
  const { settings, changed } = withClaudeHooks(existing, CMDS);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  // Bash hook still there, AskUserQuestion added alongside
  expect(hooks.PreToolUse.length).toBe(2);
  expect(hooks.PreToolUse[0]).toMatchObject({ matcher: 'Bash' });
  expect(hooks.SessionStart).toEqual(existing.hooks.SessionStart);
});

test('claudeHooksInstalled: false when one group is missing', () => {
  const partial = {
    hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CMDS.ask }] }] },
  };
  expect(claudeHooksInstalled(partial, CMDS)).toBe(false); // PermissionRequest + StopFailure missing
  const noStopFailure = withClaudeHooks({}, CMDS).settings;
  delete (noStopFailure.hooks as Record<string, unknown>).StopFailure;
  expect(claudeHooksInstalled(noStopFailure, CMDS)).toBe(false);
});

test('an older install (ask-only) is upgraded in place: only missing groups append', () => {
  // Simulate a pre-#113 settings file: ask groups present, StopFailure absent.
  const legacy = withClaudeHooks({}, CMDS).settings;
  delete (legacy.hooks as Record<string, unknown>).StopFailure;
  const { settings, changed } = withClaudeHooks(legacy, CMDS);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  expect(hooks.PreToolUse.length).toBe(1); // not duplicated
  expect(hooks.StopFailure.length).toBe(1); // added
});

test('detects a catch-all PermissionRequest with a missing matcher as installed', () => {
  const s = withClaudeHooks({}, CMDS).settings;
  // simulate a hand-written group with no matcher (== '*')
  (s.hooks as Record<string, unknown[]>).PermissionRequest = [{ hooks: [{ type: 'command', command: CMDS.ask }] }];
  expect(claudeHooksInstalled(s, CMDS)).toBe(true);
});

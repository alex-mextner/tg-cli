import { expect, test } from 'bun:test';
import {
  withClaudeHooks,
  claudeHooksInstalled,
  withHarnessHooks,
  harnessHooksInstalled,
  withClaudeStatusLineTelemetry,
  claudeStatusLineTelemetryInstalled,
  withCodexUsageHook,
  codexUsageHookInstalled,
} from '../features/tg-ctl/hook-install';

const CMD = 'tg-ctl ask';
const HARNESS_CMD = 'tg-ctl harness-event';
const STATUSLINE_TELEMETRY_CMD = 'tg-ctl harness-event --agent claude';
const CODEX_USAGE_CMD = 'tg-ctl codex-usage-hook';

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

// --- Claude statusLine proactive usage telemetry (#132 follow-up) ---

test('statusLine telemetry: wraps an existing statusLine command and preserves its output path', () => {
  const existing = {
    statusLine: {
      type: 'command',
      command: 'input=$(cat); printf "model=%s" "$(echo "$input" | jq -r .model.display_name)"',
    },
  };
  const { settings, changed } = withClaudeStatusLineTelemetry(existing, STATUSLINE_TELEMETRY_CMD);
  expect(changed).toBe(true);
  const statusLine = settings.statusLine as { type: string; command: string };
  expect(statusLine.type).toBe('command');
  expect(statusLine.command).toContain('tg-ctl-statusline-usage');
  expect(statusLine.command).toContain(STATUSLINE_TELEMETRY_CMD);
  expect(statusLine.command).toContain('mktemp');
  expect(statusLine.command).toContain('chmod 600');
  expect(statusLine.command).toContain('trap');
  expect(statusLine.command).toContain('TG_CTL_STATUSLINE_MIN_INTERVAL_SEC');
  expect(statusLine.command).toContain('tg-claude-statusline-usage.stamp');
  expect(statusLine.command).toContain("sh -c 'input=$(cat); printf");
  expect(statusLine.command).not.toContain('&;');
  expect(statusLine.command).not.toContain('tg-claude-statusline-usage.$$');
  expect(claudeStatusLineTelemetryInstalled(settings, STATUSLINE_TELEMETRY_CMD)).toBe(true);
});

test('statusLine telemetry: without an existing statusLine it installs a silent collector, not a new jq display', () => {
  const { settings } = withClaudeStatusLineTelemetry({}, STATUSLINE_TELEMETRY_CMD);
  const statusLine = settings.statusLine as { command: string };
  expect(statusLine.command).toContain("sh -c ':'");
  expect(statusLine.command).not.toContain('jq -r');
});

test('statusLine telemetry: idempotent re-run does not wrap twice', () => {
  const once = withClaudeStatusLineTelemetry({}, STATUSLINE_TELEMETRY_CMD).settings;
  const twice = withClaudeStatusLineTelemetry(once, STATUSLINE_TELEMETRY_CMD);
  expect(twice.changed).toBe(false);
  const statusLine = twice.settings.statusLine as { command: string };
  expect(statusLine.command.match(/tg-ctl-statusline-usage/g)?.length).toBe(1);
});

test('statusLine telemetry: current display-only statusLine is not considered installed', () => {
  const displayOnly = {
    statusLine: {
      type: 'command',
      command: 'input=$(cat); cwd=$(echo "$input" | jq -r \'.workspace.current_dir\'); printf "%s" "$cwd"',
    },
  };
  expect(claudeStatusLineTelemetryInstalled(displayOnly, STATUSLINE_TELEMETRY_CMD)).toBe(false);
});

test('statusLine telemetry: old predictable-temp wrapper is treated as stale and rewritten', () => {
  const stale = {
    statusLine: {
      type: 'command',
      command:
        'input=$(cat); tmp="${TMPDIR:-/tmp}/tg-claude-statusline-usage.$$.$RANDOM.json"; printf \'%s\' "$input" > "$tmp"; nohup sh -c \'tg-ctl harness-event --agent claude < "$1"; rm -f "$1"\' sh "$tmp" >/dev/null 2>&1 & printf \'%s\' "$input" | sh -c \':\'; # tg-ctl-statusline-usage',
    },
  };
  expect(claudeStatusLineTelemetryInstalled(stale, STATUSLINE_TELEMETRY_CMD)).toBe(false);
  const rewritten = withClaudeStatusLineTelemetry(stale, STATUSLINE_TELEMETRY_CMD);
  expect(rewritten.changed).toBe(true);
  const statusLine = rewritten.settings.statusLine as { command: string };
  expect(statusLine.command).toContain('mktemp');
  expect(statusLine.command).not.toContain('tg-claude-statusline-usage.$$');
});

test('statusLine telemetry: secure wrapper without throttle is treated as stale and rewritten', () => {
  const stale = {
    statusLine: {
      type: 'command',
      command:
        'input=$(cat); tmp=$(mktemp "${TMPDIR:-/tmp}/tg-claude-statusline-usage.XXXXXX"); trap \'rm -f "$tmp"\' EXIT INT TERM; printf \'%s\' "$input" > "$tmp"; nohup sh -c \'tg-ctl harness-event --agent claude < "$1"\' sh "$tmp" >/dev/null 2>&1 & printf \'%s\' "$input" | sh -c \':\'; # tg-ctl-statusline-usage',
    },
  };
  expect(claudeStatusLineTelemetryInstalled(stale, STATUSLINE_TELEMETRY_CMD)).toBe(false);

  const rewritten = withClaudeStatusLineTelemetry(stale, STATUSLINE_TELEMETRY_CMD);
  expect(rewritten.changed).toBe(true);
  const statusLine = rewritten.settings.statusLine as { command: string };
  expect(statusLine.command).toContain('TG_CTL_STATUSLINE_MIN_INTERVAL_SEC');
  expect(statusLine.command).toContain('tg-claude-statusline-usage.stamp');
});

test('statusLine telemetry: stale rewrap preserves a display command containing quotes and nested sh -c', () => {
  const displayCommand = 'printf \'cwd: %s\' "$PWD"; printf \'%s\' "$input" | sh -c \'cat >/dev/null\'';
  const wrapped = withClaudeStatusLineTelemetry(
    { statusLine: { type: 'command', command: displayCommand } },
    STATUSLINE_TELEMETRY_CMD,
  ).settings;
  const stale = {
    ...wrapped,
    statusLine: {
      ...(wrapped.statusLine as Record<string, unknown>),
      command: ((wrapped.statusLine as { command: string }).command).replace('mktemp', 'mktmp-old'),
    },
  };

  const rewritten = withClaudeStatusLineTelemetry(stale, STATUSLINE_TELEMETRY_CMD);
  expect(rewritten.changed).toBe(true);
  const statusLine = rewritten.settings.statusLine as { command: string };
  expect(statusLine.command).toContain('mktemp');
  expect(statusLine.command).toContain('cwd: %s');
  expect(statusLine.command).toContain('cat >/dev/null');
  expect(statusLine.command.match(/tg-ctl-statusline-usage/g)?.length).toBe(1);
});

test('statusLine telemetry: primitive or array statusLine installs the silent collector', () => {
  for (const statusLine of ['printf nope', [], { type: 'command' }]) {
    const { settings } = withClaudeStatusLineTelemetry({ statusLine }, STATUSLINE_TELEMETRY_CMD);
    expect((settings.statusLine as { command: string }).command).toContain("sh -c ':'");
  }
});

test('statusLine telemetry: a user command containing the marker is preserved if it is not our wrapper', () => {
  const command = 'printf "literal tg-ctl-statusline-usage marker"';
  const { settings } = withClaudeStatusLineTelemetry({ statusLine: { type: 'command', command } }, STATUSLINE_TELEMETRY_CMD);
  const statusLine = settings.statusLine as { command: string };
  expect(statusLine.command).toContain(command);
  expect(statusLine.command).not.toContain("sh -c ':'");
});

// --- Codex Stop-hook usage telemetry collector (#176) ---

test('Codex usage hook: empty hooks → Stop collector added, changed=true', () => {
  const { settings, changed } = withCodexUsageHook({}, CODEX_USAGE_CMD);
  expect(changed).toBe(true);
  const hooks = settings.hooks as Record<string, unknown[]>;
  expect(hooks.Stop).toEqual([
    { hooks: [{ type: 'command', command: CODEX_USAGE_CMD, timeout: 30 }] },
  ]);
  expect(codexUsageHookInstalled(settings, CODEX_USAGE_CMD)).toBe(true);
});

test('Codex usage hook: idempotent re-run does not duplicate', () => {
  const once = withCodexUsageHook({}, CODEX_USAGE_CMD).settings;
  const twice = withCodexUsageHook(once, CODEX_USAGE_CMD);
  expect(twice.changed).toBe(false);
  expect((twice.settings.hooks as Record<string, unknown[]>).Stop.length).toBe(1);
});

test('Codex usage hook: preserves unrelated hook groups', () => {
  const existing = {
    hooks: {
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'tg-ctl ask --agent codex' }] }],
    },
  };
  const { settings } = withCodexUsageHook(existing, CODEX_USAGE_CMD);
  const hooks = settings.hooks as Record<string, unknown[]>;
  expect(hooks.PermissionRequest).toEqual(existing.hooks.PermissionRequest);
  expect(hooks.Stop).toHaveLength(1);
});

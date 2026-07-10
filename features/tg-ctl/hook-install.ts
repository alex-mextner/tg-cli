// Idempotent installer for the q→buttons agent-question hooks
// (docs/specs/2026-06-10-tg-ctl-control-design.md §8). PURE: the entrypoint
// reads/writes ~/.claude/settings.json (backing it up first) and prints guidance;
// these helpers do the JSON merge + detection.
//
// Claude Code intercepts the `AskUserQuestion` tool via a PreToolUse matcher (it
// is a tool, not its own event — confirmed against the live hooks docs) and tool
// permissions via the `PermissionRequest` event. Hooks MERGE across scopes and
// multiple matchers coexist, so adding ours never clobbers existing hooks; the
// merge is keyed on (event, matcher, command) so re-running is a no-op.
//
// PLAN-APPROVAL (ExitPlanMode) is intentionally NOT given its own PreToolUse
// matcher: per the live hooks docs both PreToolUse AND PermissionRequest can fire
// for the SAME ExitPlanMode call, so a dedicated PreToolUse matcher would forward
// the plan to Telegram twice (and leave the losing `tg-ctl ask` process blocked
// until its 120s timeout). The `PermissionRequest *` catch-all already delivers
// ExitPlanMode exactly once; `hook-normalize.ts` recognizes the tool there and
// renders Proceed/Keep-planning buttons regardless of which event carried it.

interface HookCmd {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCmd[];
}

const TIMEOUT_SEC = 120;
// A StopFailure hook must be quick — it only shells `tg-ctl harness-event`, which
// sends one message and returns; it does not block on a Telegram round-trip the
// way the 120s q→buttons hook does.
const HARNESS_TIMEOUT_SEC = 30;
const STATUSLINE_TELEMETRY_MARKER = 'tg-ctl-statusline-usage';
const STATUSLINE_DISPLAY_COMMAND_PREFIX = 'printf \'%s\' "$input" | sh -c ';
const STATUSLINE_TELEMETRY_MIN_INTERVAL_SEC = 30;
const SILENT_STATUSLINE_COMMAND = ':';

// The q→buttons hook groups we install, as (event, group) entries.
function desiredGroups(command: string): Array<{ event: string; group: HookGroup }> {
  const cmd: HookCmd = { type: 'command', command, timeout: TIMEOUT_SEC };
  return [
    { event: 'PreToolUse', group: { matcher: 'AskUserQuestion', hooks: [cmd] } },
    { event: 'PermissionRequest', group: { matcher: '*', hooks: [cmd] } },
  ];
}

// The harness-failure hook group (tg-cli#113): Claude Code 2.1.x fires StopFailure
// when a turn ends on an API failure / usage limit. The `*` matcher catches every
// failure matcher (rate_limit, overloaded, billing_error, session_limit, …); the
// command normalizes the payload and notifies Telegram + offers auto-continue.
function desiredHarnessGroups(command: string): Array<{ event: string; group: HookGroup }> {
  const cmd: HookCmd = { type: 'command', command, timeout: HARNESS_TIMEOUT_SEC };
  return [{ event: 'StopFailure', group: { matcher: '*', hooks: [cmd] } }];
}

function desiredCodexUsageGroups(command: string): Array<{ event: string; group: HookGroup }> {
  const cmd: HookCmd = { type: 'command', command, timeout: HARNESS_TIMEOUT_SEC };
  return [{ event: 'Stop', group: { hooks: [cmd] } }];
}

function groupHasCommand(group: unknown, matcher: string, command: string): boolean {
  if (!group || typeof group !== 'object') return false;
  const g = group as Record<string, unknown>;
  // A missing matcher means "all tools" — treat it and '*' as the same catch-all.
  const gm = typeof g.matcher === 'string' ? g.matcher : '*';
  if (gm !== (matcher || '*')) return false;
  const hooks = Array.isArray(g.hooks) ? g.hooks : [];
  return hooks.some((h) => h && typeof h === 'object' && (h as Record<string, unknown>).command === command);
}

// Are all of `groups` (each keyed on its command) already present in settings?
function groupsInstalled(settings: Record<string, unknown>, groups: Array<{ event: string; group: HookGroup }>, command: string): boolean {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? (settings.hooks as Record<string, unknown>) : {};
  for (const { event, group } of groups) {
    const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    if (!arr.some((g) => groupHasCommand(g, group.matcher ?? '', command))) return false;
  }
  return true;
}

// Merge `groups` into settings, preserving existing hooks; a group is appended
// only when an equivalent one (same event/matcher/command) is absent, so
// re-running is a no-op. Returns a shallow copy + whether anything changed.
function mergeGroups(
  settings: Record<string, unknown>,
  groups: Array<{ event: string; group: HookGroup }>,
  command: string,
): { settings: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...settings };
  const hooks: Record<string, unknown> = next.hooks && typeof next.hooks === 'object' ? { ...(next.hooks as Record<string, unknown>) } : {};
  let changed = false;
  for (const { event, group } of groups) {
    const existing = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    if (!existing.some((g) => groupHasCommand(g, group.matcher ?? '', command))) {
      existing.push(group);
      changed = true;
    }
    hooks[event] = existing;
  }
  next.hooks = hooks;
  return { settings: next, changed };
}

export function claudeHooksInstalled(settings: Record<string, unknown>, command: string): boolean {
  return groupsInstalled(settings, desiredGroups(command), command);
}

// Return a deep-ish copy of `settings` with the q→buttons hook groups merged in.
export function withClaudeHooks(settings: Record<string, unknown>, command: string): { settings: Record<string, unknown>; changed: boolean } {
  return mergeGroups(settings, desiredGroups(command), command);
}

export function harnessHooksInstalled(settings: Record<string, unknown>, command: string): boolean {
  return groupsInstalled(settings, desiredHarnessGroups(command), command);
}

// Return a copy of `settings` with the StopFailure harness hook merged in (#113).
export function withHarnessHooks(settings: Record<string, unknown>, command: string): { settings: Record<string, unknown>; changed: boolean } {
  return mergeGroups(settings, desiredHarnessGroups(command), command);
}

export function codexUsageHookInstalled(settings: Record<string, unknown>, command: string): boolean {
  return groupsInstalled(settings, desiredCodexUsageGroups(command), command);
}

export function withCodexUsageHook(settings: Record<string, unknown>, command: string): { settings: Record<string, unknown>; changed: boolean } {
  return mergeGroups(settings, desiredCodexUsageGroups(command), command);
}

function statusLineCommand(settings: Record<string, unknown>): string | null {
  const statusLine = settings.statusLine;
  if (!statusLine || typeof statusLine !== 'object' || Array.isArray(statusLine)) return null;
  const command = (statusLine as Record<string, unknown>).command;
  return typeof command === 'string' && command.trim() ? command : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseShellSingleQuoted(value: string, start: number): string | null {
  if (value[start] !== "'") return null;
  let out = '';
  for (let i = start + 1; i < value.length; i++) {
    if (value.startsWith(`'\\''`, i)) {
      out += "'";
      i += 3;
      continue;
    }
    if (value[i] === "'") return out;
    out += value[i];
  }
  return null;
}

function unwrapStatusLineTelemetryDisplayCommand(commandText: string): string | null {
  const markerIndex = commandText.indexOf(STATUSLINE_TELEMETRY_MARKER);
  if (markerIndex < 0) return null;
  const displayStart = commandText.indexOf(STATUSLINE_DISPLAY_COMMAND_PREFIX);
  if (displayStart < 0 || displayStart > markerIndex) return null;
  return parseShellSingleQuoted(commandText, displayStart + STATUSLINE_DISPLAY_COMMAND_PREFIX.length);
}

function buildStatusLineTelemetryCommand(displayCommand: string, telemetryCommand: string): string {
  const telemetryScript = `trap 'rm -f "$1"' EXIT INT TERM; ${telemetryCommand} < "$1"`;
  const prefix = [
    'input=$(cat)',
    `interval=\${TG_CTL_STATUSLINE_MIN_INTERVAL_SEC:-${STATUSLINE_TELEMETRY_MIN_INTERVAL_SEC}}`,
    `case "$interval" in ''|*[!0-9]*) interval=${STATUSLINE_TELEMETRY_MIN_INTERVAL_SEC};; esac`,
    'stamp="${TMPDIR:-/tmp}/tg-claude-statusline-usage.stamp"',
    'now=$(date +%s 2>/dev/null || printf 0)',
    'last=$(cat "$stamp" 2>/dev/null); case "$last" in \'\'|*[!0-9]*) last=0;; esac',
    'tmp=',
    'if [ "$interval" -eq 0 ] || [ $((now - last)) -ge "$interval" ]; then printf \'%s\' "$now" > "$stamp" 2>/dev/null || true; tmp=$(mktemp "${TMPDIR:-/tmp}/tg-claude-statusline-usage.XXXXXX") || tmp=; if [ -n "$tmp" ]; then chmod 600 "$tmp" 2>/dev/null || true; printf \'%s\' "$input" > "$tmp"; fi; fi',
  ].join('; ');
  return `${prefix}; if [ -n "$tmp" ]; then nohup sh -c ${shellQuote(telemetryScript)} sh "$tmp" >/dev/null 2>&1 & fi; ${STATUSLINE_DISPLAY_COMMAND_PREFIX}${shellQuote(displayCommand)}; # ${STATUSLINE_TELEMETRY_MARKER}`;
}

export function claudeStatusLineTelemetryInstalled(settings: Record<string, unknown>, command: string): boolean {
  const commandText = statusLineCommand(settings);
  return (
    commandText !== null &&
    commandText.includes(STATUSLINE_TELEMETRY_MARKER) &&
    commandText.includes(command) &&
    commandText.includes('mktemp') &&
    commandText.includes('trap') &&
    commandText.includes('TG_CTL_STATUSLINE_MIN_INTERVAL_SEC') &&
    commandText.includes('tg-claude-statusline-usage.stamp')
  );
}

export function withClaudeStatusLineTelemetry(
  settings: Record<string, unknown>,
  command: string,
): { settings: Record<string, unknown>; changed: boolean } {
  if (claudeStatusLineTelemetryInstalled(settings, command)) return { settings, changed: false };
  const currentStatusLine = settings.statusLine && typeof settings.statusLine === 'object' && !Array.isArray(settings.statusLine)
    ? (settings.statusLine as Record<string, unknown>)
    : {};
  const existingCommand = statusLineCommand(settings);
  const displayCommand = existingCommand && existingCommand.includes(STATUSLINE_TELEMETRY_MARKER)
    ? (unwrapStatusLineTelemetryDisplayCommand(existingCommand) ?? existingCommand)
    : (existingCommand ?? SILENT_STATUSLINE_COMMAND);
  return {
    settings: {
      ...settings,
      statusLine: {
        ...currentStatusLine,
        type: 'command',
        command: buildStatusLineTelemetryCommand(displayCommand, command),
      },
    },
    changed: true,
  };
}

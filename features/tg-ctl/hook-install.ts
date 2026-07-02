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

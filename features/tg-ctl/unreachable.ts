// Agents running OUTSIDE tmux (tg-cli#306): discovery from the process table, the
// per-agent inbox KEY shared with the Stop-hook reader in agent-tools, and the
// human-facing texts (status lines, the "queued" reply, the no-agent listing).
//
// PURE — the tg-ctl entrypoint runs `ps -axo pid=,tty=` / `lsof -a -p <pid> -d cwd -Fn`
// and hands the raw stdout here. Everything below is plain data work.
//
// WHY: tg-ctl discovers agents via `tmux list-panes` and delivers via `tmux send-keys`,
// so an interactive `claude`/`codex`/`opencode` started from a plain terminal tab does
// not exist for it — silently (incident 2026-09-05: agents `landing` and `rig-fable`).
// This module makes such agents VISIBLE (status + picker list them as unreachable with
// the reason) and gives them a tmux-free delivery channel: an inbox file the harness's
// Stop hook (agent-tools `cc_hook_bridge`) reads at the agent's next turn end.
//
// THE INBOX KEY CONTRACT (shared with agent-tools `lib/agenttools_tg_inbox` — the two
// implementations MUST stay byte-identical, both READMEs document it):
//   key = sanitized(--name value)                  when the agent argv carries `--name X`
//       = "cwd-" + sha256(cwd)[:16] (hex)          otherwise
//   sanitized(x) = every char outside [A-Za-z0-9._-] → "_", truncated to 64 chars;
//                  an empty result counts as "no name".
//   cwd is the agent process's working directory with trailing "/" stripped ("/" stays).
//   inbox dir = <tg-cli config dir>/inbox/<key>/   (config dir = $TG_CTL_CONFIG_DIR or
//               ~/.config/tg-cli)
//   pending.jsonl            — appended by the daemon (one JSON object per line)
//   delivered-<pid>-<ts>.jsonl — ONE file per Stop-hook consumption, written whole
//                              (temp + rename) — never a shared append target, so the
//                              daemon's claim can never race an in-flight hook write
//   acked.jsonl              — appended by the daemon after it reacted on Telegram

import { createHash } from 'crypto';
import type { AgentKind, PaneInfo, ProcInfo } from './types';
import { matchAgentCommand } from './discover';

export interface UnreachableAgent {
  pid: number;
  agent: AgentKind;
  tty: string;
  command: string;
  name: string | null; // the `--name` value as typed (unsanitized), null when absent
  cwd: string | null; // resolved by the caller (lsof); null when unresolvable
}

// `ps -axo pid=,tty=` → pid → tty. A tty of `??` (macOS) / `?` (Linux) means NO
// controlling terminal (a daemon, a `-p` run under a tool, a launchd child) and is
// dropped. Lines with extra tokens are skipped — this keeps the parser inert against
// the legacy 3-column fake `ps` scripts the integration suite ships (they ignore
// their argv and print `pid ppid command`), so those tests see no tty map at all.
export function parsePidTtyList(out: string): Map<number, string> {
  const ttyByPid = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s*$/);
    if (!m) continue;
    const tty = m[2];
    if (tty === '??' || tty === '?' || tty === '-') continue;
    ttyByPid.set(Number(m[1]), tty);
  }
  return ttyByPid;
}

// `lsof -a -p <pid> -d cwd -Fn` prints field lines: `p<pid>`, `fcwd`, `n<path>`.
// Returns the first `n` path, or null when lsof printed nothing usable.
export function parseLsofCwd(out: string): string | null {
  for (const line of out.split('\n')) {
    if (line.startsWith('n') && line.length > 1) return line.slice(1).replace(/\r$/, '');
  }
  return null;
}

// The `--name <value>` / `--name=<value>` an interactive Claude Code session was
// started with (undocumented in `claude --help`, but it is what `tg-ctl` labels a tmux
// pane by and what the user types to address the agent). Returns the value AS TYPED;
// `agentInboxKey` sanitizes it. Null when absent or when the flag has no value.
// `ps` flattens argv into one space-joined string, so a multi-word value (`--name "my
// agent"`) yields only its FIRST word — the Python reader in agent-tools reads the same
// flattened `ps -o args=` line and splits the same way, so both sides agree on `my`.
export function parseAgentNameFromCommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--name') {
      const v = tokens[i + 1];
      return v && !v.startsWith('-') ? v : null;
    }
    if (t.startsWith('--name=')) {
      const v = t.slice('--name='.length);
      return v ? v : null;
    }
  }
  return null;
}

// Sanitize a `--name` value into a filesystem-safe key segment. Empty → null. A value
// made only of dots (`.`, `..`) is null too: dots are allowed characters, so it would
// otherwise survive and resolve `inbox/<key>` to the inbox root or its PARENT — this is
// the single gate between a user-typed value and a path (review finding).
export function sanitizeAgentName(name: string): string | null {
  const s = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  if (!s || /^\.+$/.test(s)) return null;
  return s;
}

function normalizeCwd(cwd: string): string {
  const stripped = cwd.replace(/\/+$/, '');
  return stripped ? stripped : '/';
}

// THE shared key (see the contract at the top of this file).
export function agentInboxKey(name: string | null | undefined, cwd: string): string {
  const safe = name ? sanitizeAgentName(name) : null;
  if (safe) return safe;
  const digest = createHash('sha256').update(normalizeCwd(cwd), 'utf8').digest('hex');
  return `cwd-${digest.slice(0, 16)}`;
}

// Options that mark a NON-interactive invocation of an agent binary: a `-p`
// (`--print`) run is a one-shot tool call, the `--bg*` flags are Claude Code's own
// background helpers — none of them is a session a human addresses from Telegram.
const NON_INTERACTIVE_OPTIONS = new Set(['--print', '-p', '--bg', '--background']);
// Subcommands (the FIRST positional word) with the same meaning: `codex exec` is the
// headless mode, `claude daemon` / `bg-*` are background helpers.
const NON_INTERACTIVE_SUBCOMMANDS = new Set(['exec', 'daemon', 'bg-pty-host', 'bg-spare']);
// Options that take a value — the value is never a subcommand or an option.
const VALUE_OPTIONS = new Set(['--name', '--model', '--resume', '-r', '--session-id', '--add-dir', '--profile']);

// Only the REAL option / subcommand positions count (review finding): an agent CLI
// accepts an arbitrary initial prompt, so `claude "please exec tests"` must stay
// interactive. Scanning stops at `--`; a positional is checked only when it is the
// first one (the subcommand slot); a path-like positional (the launcher's
// `node …/claude` shape) is skipped, as is the value of a value-taking option.
export function isInteractiveAgentCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/).slice(1);
  let sawPositional = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') break;
    if (t.startsWith('-')) {
      if (NON_INTERACTIVE_OPTIONS.has(t)) return false;
      if (VALUE_OPTIONS.has(t)) i++;
      continue;
    }
    if (t.includes('/')) continue;
    if (!sawPositional) {
      sawPositional = true;
      if (NON_INTERACTIVE_SUBCOMMANDS.has(t)) return false;
    }
  }
  return true;
}

// Every pid that lives UNDER some tmux pane (the pane process itself + all its
// descendants) — those agents are reachable via send-keys and are never "unreachable".
function pidsUnderPanes(panes: PaneInfo[], procs: ProcInfo[]): Set<number> {
  const byPpid = new Map<number, number[]>();
  for (const p of procs) {
    const kids = byPpid.get(p.ppid);
    if (kids) kids.push(p.pid);
    else byPpid.set(p.ppid, [p.pid]);
  }
  const covered = new Set<number>();
  for (const pane of panes) {
    const queue = [pane.panePid];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (covered.has(pid)) continue;
      covered.add(pid);
      for (const kid of byPpid.get(pid) ?? []) queue.push(kid);
    }
  }
  return covered;
}

// Interactive agent processes (a controlling tty, no `--print`/helper shape) that sit
// in NO tmux pane's process tree. A proc whose IMMEDIATE PARENT is itself a matched
// agent (a `node …/claude` launcher wrapping the real binary) is folded into that
// parent, so a wrapper + binary pair yields one agent, not two. Only the direct parent
// counts: a session started from another agent's shell tool (a nested `claude` a few
// hops below a `claude`) is a DISTINCT agent and must stay listed — verified live: the
// first cut folded on any ancestor and hid exactly the test session (tg-cli#306).
// `cwd` is left null — the caller resolves it (lsof) because it is I/O.
export function findUnreachableAgents(
  panes: PaneInfo[],
  procs: ProcInfo[],
  ttyByPid: Map<number, string>,
): UnreachableAgent[] {
  const covered = pidsUnderPanes(panes, procs);
  const byPid = new Map<number, ProcInfo>();
  for (const p of procs) byPid.set(p.pid, p);
  const matched = new Map<number, AgentKind>();
  for (const p of procs) {
    const tty = ttyByPid.get(p.pid);
    if (!tty || covered.has(p.pid)) continue;
    const agent = matchAgentCommand(p.command);
    if (!agent || !isInteractiveAgentCommand(p.command)) continue;
    matched.set(p.pid, agent);
  }
  const out: UnreachableAgent[] = [];
  for (const [pid, agent] of matched) {
    const proc = byPid.get(pid)!;
    if (matched.has(proc.ppid)) continue; // the binary under its own launcher wrapper
    out.push({
      pid,
      agent,
      tty: ttyByPid.get(pid)!,
      command: proc.command,
      name: parseAgentNameFromCommand(proc.command),
      cwd: null,
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

function cwdBasename(path: string | null): string {
  if (!path) return '';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// The human label — the `--name` when given, else the cwd project dir: the SAME
// fallback tier `resolveWindowAgentLabel` uses for a tmux pane whose window name is
// bare, so an agent is called the same thing whether or not it sits in tmux. An
// unnamed agent whose cwd could not be resolved is named by its pid (cwdBasename
// yields '' there, which `??` would NOT fall through — hence the `|| null`).
export function unreachableLabel(a: UnreachableAgent): string {
  return a.name ?? (cwdBasename(a.cwd) || null) ?? `pid ${a.pid}`;
}

// The inbox key, or null when it is UNKNOWN: an unnamed agent whose cwd lsof could not
// resolve has no honest key — fabricating one from the pid would point status at an
// empty directory ("0 queued") while a message sits in the real cwd-keyed inbox.
export function unreachableKey(a: UnreachableAgent): string | null {
  if (a.name && sanitizeAgentName(a.name)) return agentInboxKey(a.name, '');
  return a.cwd ? agentInboxKey(null, a.cwd) : null;
}

// Other LIVE agents that would read the SAME inbox as `target` — two sessions whose
// distinct `--name` values sanitize to one key (`a/b` and `a?b` → `a_b`), or two
// unnamed sessions in one cwd. Queueing to a shared key could hand a message to the
// wrong session, so the caller refuses when this is non-empty.
export function inboxKeyCollisions(target: UnreachableAgent, agents: UnreachableAgent[]): UnreachableAgent[] {
  const key = unreachableKey(target);
  if (key === null) return [];
  return agents.filter((a) => a.pid !== target.pid && unreachableKey(a) === key);
}

// Match a typed `/agent <selector>` against unreachable agents: exact (case-insensitive)
// on the `--name`, then on the cwd basename. STRICT on purpose — this is the fallback
// consulted only after no tmux pane matched, and queueing to the wrong agent's inbox is
// a silent misroute, so no fuzzy tier here.
export function matchUnreachable(selector: string, agents: UnreachableAgent[]): UnreachableAgent[] {
  const sel = selector.trim().toLowerCase();
  if (!sel) return [];
  const byName = agents.filter((a) => a.name !== null && a.name.toLowerCase() === sel);
  if (byName.length > 0) return byName;
  return agents.filter((a) => cwdBasename(a.cwd).toLowerCase() === sel);
}

// One status line per unreachable agent (used by `tg-ctl status` and /status).
export function describeUnreachable(a: UnreachableAgent, pendingCount: number): string {
  const label = unreachableLabel(a);
  const parts = [`tty ${a.tty}`, `cwd ${a.cwd ?? '?'}`, `name ${a.name ?? '-'}`, `pid ${a.pid}`];
  const pending = pendingCount > 0 ? `, ${pendingCount} queued` : '';
  return `${label} · ${a.agent} — unreachable: not in tmux (${parts.join(', ')})${pending}`;
}

export const UNREACHABLE_HINT =
  'Not in tmux → no direct injection; a message sent with `/agent <name> <text>` is queued to its ' +
  'Stop-hook inbox and delivered when the agent next ends a turn (an idle agent gets it only at its ' +
  'next turn). To make it fully reachable, restart it inside tmux: `claude-rotate --tmux <name>`.';

// The reply for a message that could not be injected anywhere. With unreachable agents
// present it LISTS them (the whole point of #306: never a silent drop, never a bare
// "not in tmux" when the agent is right there); without any it is the legacy text.
export function noAgentReplyText(legacy: string, agents: UnreachableAgent[]): string {
  if (agents.length === 0) return legacy;
  const lines = agents.map((a) => `  - ${describeUnreachable(a, 0)}`);
  return (
    `No agent in tmux. Running OUTSIDE tmux (unreachable for direct injection):\n${lines.join('\n')}\n` +
    UNREACHABLE_HINT
  );
}

// The reply after a message was queued to an unreachable agent's inbox.
export function queuedReplyText(a: UnreachableAgent): string {
  return (
    `${unreachableLabel(a)} is running outside tmux (tty ${a.tty}, cwd ${a.cwd ?? '?'}) — queued to its ` +
    'Stop-hook inbox; delivered when the agent next ends a turn (an idle agent receives it only at its ' +
    'next turn). You get a 👌 reaction on this message once it is delivered.'
  );
}

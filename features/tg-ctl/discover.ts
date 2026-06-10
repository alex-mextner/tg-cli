// tmux pane discovery for tg-ctl (spec §5.2 target discovery, §10 ambiguity).
//
// Everything here is PURE — the tg-ctl entrypoint runs
//   tmux list-panes -a -F '#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}'
//   ps -axo pid=,ppid=,command=
// and hands the raw stdout to these parsers. Picking the injection target from
// the parsed snapshots is plain data work, trivially unit-testable.

import type {
  AgentKind,
  DiscoverResult,
  PaneInfo,
  ProcInfo,
  Registration,
  TargetPane,
} from './types';

// Tab-separated on purpose: pane_current_path may contain spaces, and tmux
// format fields never contain tabs. Malformed lines are skipped, not fatal —
// a half-broken snapshot should degrade to "fewer candidates", never crash.
export function parsePaneList(out: string): PaneInfo[] {
  const panes: PaneInfo[] = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const windowIndex = Number(parts[1]);
    const panePid = Number(parts[3]);
    if (!Number.isInteger(windowIndex) || !Number.isInteger(panePid)) continue;
    panes.push({
      sessionName: parts[0],
      windowIndex,
      paneId: parts[2],
      panePid,
      paneCommand: parts[4],
      // A path could itself contain a tab; rejoin the tail instead of dropping it.
      panePath: parts.slice(5).join('\t'),
    });
  }
  return panes;
}

// `ps -axo pid=,ppid=,command=`: two right-aligned ints, then the command line
// (which freely contains spaces) to the end of the line.
export function parseProcList(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S.*)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return procs;
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

// Match a single process command line to an agent. Shells (-zsh, bash, …) and
// everything else fall through to null — they are traversed, never matched.
function matchAgentCommand(command: string): AgentKind | null {
  const trimmed = command.trim();
  const argv0 = trimmed.split(/\s+/, 1)[0] ?? '';
  const base = basename(argv0);
  // claude also matches via a wrapper argv0 (e.g. `node …/.claude/local/claude --resume`).
  if (
    base === 'claude' ||
    trimmed === 'claude' ||
    trimmed.startsWith('claude ') ||
    trimmed.includes('/claude ')
  ) {
    return 'claude';
  }
  if (base === 'opencode' || base === 'opencode.exe') return 'opencode';
  if (base === 'codex') return 'codex';
  if (base === 'pi') return 'pi';
  if (base === 'aider') return 'aider';
  return null;
}

// CRITICAL repo fact (verified live on CC 2.1.150): a Claude Code pane reports
// its VERSION string (e.g. '2.1.150') as pane_current_command, NOT 'claude'.
// Pane-command matching therefore does NOT work for cc — only walking the
// process tree under pane_pid does. BFS includes pane_pid itself (an agent
// launched directly by tmux IS the pane process) and stops at the first match,
// so the shallowest agent wins. A visited set guards against pid-reuse
// artifacts in the ps snapshot.
export function findAgentInPane(
  pane: PaneInfo,
  procs: ProcInfo[],
): { agent: AgentKind; pid?: number } | null {
  const byPid = new Map<number, ProcInfo>();
  const byPpid = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const siblings = byPpid.get(p.ppid);
    if (siblings) siblings.push(p);
    else byPpid.set(p.ppid, [p]);
  }

  const queue: number[] = [pane.panePid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = byPid.get(pid);
    if (proc) {
      const agent = matchAgentCommand(proc.command);
      if (agent) return { agent, pid: proc.pid };
    }
    for (const child of byPpid.get(pid) ?? []) queue.push(child.pid);
  }
  return null;
}

// Pick the injection target (spec §10 priority chain):
//   1. registration paneId — but only if that pane STILL hosts an agent
//      (the snapshot may be minutes old; never inject into a bare shell);
//   2. fixed `control.session` — sole agent pane there wins, several there
//      is already ambiguous (the user pinned the session on purpose);
//   3. registration cwd === pane_current_path;
//   4. the sole agent pane on the whole tmux server.
// Each tier falls through when it matches nothing; a tier matching several
// panes returns 'ambiguous' with ITS narrowed candidates so the TG reply can
// name the realistic choices.
export function pickTargetPane(
  panes: PaneInfo[],
  procs: ProcInfo[],
  reg: Registration | null,
  fixedSession?: string,
): DiscoverResult {
  const candidates: TargetPane[] = [];
  for (const pane of panes) {
    const found = findAgentInPane(pane, procs);
    if (found) candidates.push({ pane, agent: found.agent, agentPid: found.pid });
  }

  if (reg?.paneId) {
    const hit = candidates.find((c) => c.pane.paneId === reg.paneId);
    if (hit) return { ok: true, target: hit };
  }

  if (fixedSession) {
    const inSession = candidates.filter((c) => c.pane.sessionName === fixedSession);
    if (inSession.length === 1) return { ok: true, target: inSession[0] };
    if (inSession.length > 1) return { ok: false, reason: 'ambiguous', candidates: inSession };
  }

  if (reg?.cwd) {
    const byCwd = candidates.filter((c) => c.pane.panePath === reg.cwd);
    if (byCwd.length === 1) return { ok: true, target: byCwd[0] };
    if (byCwd.length > 1) return { ok: false, reason: 'ambiguous', candidates: byCwd };
  }

  if (candidates.length === 1) return { ok: true, target: candidates[0] };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', candidates };
  return { ok: false, reason: 'no-agent', candidates: [] };
}

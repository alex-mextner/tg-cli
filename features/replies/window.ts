// Resolve a tmux WINDOW NAME to the set of pane ids whose window is named that,
// for `tg replies --session <name>`. The CTO recalls by human window name (`ext`),
// not by un-typeable pane ids (`%7`); a name may repeat across tmux sessions, so
// resolution returns EVERY matching pane (a union), and the caller scopes recall
// to that set.
//
// This module is PURE (per the `features/replies/` DI boundary in AGENTS.md — "all
// pure except cli.ts"): it does NO I/O of its own. `parseWindowPanes` owns the one
// subtle rule — `tmux list-panes -F "#{pane_id}\t#{window_name}"` puts the pane id
// FIRST and TAB-delimits it, because a window name can contain SPACES
// (`ext: diagram`) but never a tab. So we split each row on the FIRST tab only:
// column 0 is the pane id, everything after it is the (space-safe) name.
// `resolveWindowPanes` composes an INJECTED tmux runner with that parser; the real
// `tmux list-panes` spawn lives in the entrypoint (`tg`), which supplies the runner
// as the `resolveWindow` dep — so this file stays environment-independent + tested.

// One matching rule: exact `window_name === name`, NOT prefix or substring — the
// CTO runs both a window `ext` and a window `ext: diagram`, and `--session ext`
// must scope to ONLY `ext`.
export function parseWindowPanes(stdout: string, name: string): string[] {
  const panes: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue; // malformed row (no delimiter) — skip
    const paneId = line.slice(0, tab);
    const windowName = line.slice(tab + 1);
    if (windowName === name) panes.push(paneId);
  }
  return panes;
}

// Injectable tmux runner: returns the exit code + captured stdout, or null when
// the tmux binary is missing (spawn threw). Supplied by the entrypoint (`tg`),
// which owns the real spawn; the daemon-free unit tests feed synthetic outputs.
export type TmuxRun = () => { exitCode: number; stdout: string } | null;

// Resolve `name` to its pane-id set via the injected runner. Empty when tmux is
// absent, not reachable (no server / not in a tmux client), or no window carries
// that name — the caller turns an empty set into the structured "no tmux window
// named ..." error rather than silently recalling nothing.
export function resolveWindowPanes(name: string, run: TmuxRun): string[] {
  const r = run();
  if (r === null || r.exitCode !== 0) return [];
  return parseWindowPanes(r.stdout, name);
}

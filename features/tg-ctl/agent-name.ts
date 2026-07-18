// The human AGENT NAME for a tmux pane — the single source of truth shared by
// the WRITE side (tg-ctl stamps it as `targetAgent` on an inbound history
// record) and the READ side (`tg replies` resolves it for its OWN pane to know
// "the current agent"). Both sides MUST derive the name the same way, or the
// default agent-scoped view would filter on a name that never matches what was
// stamped.
//
// The name is the pane's tmux window name, EXCEPT when that is a bare/auto-rename
// default (isBareWindowName — an empty name, a numeric window index, a dotted
// version string, or a shell/launcher command like `node`/`zsh`). In that case
// the window name carries no project signal, so we fall back to the cwd project
// basename — exactly the tier the `/agent` picker's `distinctLabels` uses, so a
// message routed to a pane is attributed with the SAME label the picker showed.
//
// PURE — the caller supplies the already-read `#{window_name}` and
// `#{pane_current_path}`; no I/O here.

import { basename } from 'path';
import { isBareWindowName } from './agent-match';

export function agentNameForPane(
  windowName: string | null | undefined,
  panePath: string | null | undefined,
): string | null {
  const win = (windowName ?? '').trim();
  if (win && !isBareWindowName(win)) return win;
  // Window name is bare/empty → lean on the cwd project dir (the picker's tier).
  const trimmedPath = (panePath ?? '').replace(/\/+$/, '');
  const project = trimmedPath ? basename(trimmedPath) : '';
  if (project) return project;
  // Nothing usable from either signal — a genuinely empty window in a root/empty
  // cwd. Hand back the (possibly bare-but-nonempty) window name rather than null
  // so a caller still gets SOME identifier; null only when both are empty.
  return win || null;
}

// Parse a `tmux display-message -p '#{window_name}\t#{pane_current_path}'` line into the
// agent name. SPLITS ON THE FIRST TAB ONLY and strips ONLY the trailing newline — never a
// blanket `.trim()`, which would eat the tab delimiter itself when the window name is empty
// (`"\t/some/path\n"` → `"/some/path"`), shifting the PATH into the window-name slot and
// yielding a wrong label. The empty-window-name case is exactly the one the cwd fallback in
// agentNameForPane exists for (bare/auto-named panes), so it must parse correctly. A line
// with no tab is treated as a lone window name (empty path). Mirrors the daemon, which reads
// the same two tmux fields from its snapshot.
export function agentNameFromDisplayLine(raw: string): string | null {
  const line = raw.replace(/\r?\n$/, '');
  const tab = line.indexOf('\t');
  const windowName = tab >= 0 ? line.slice(0, tab) : line;
  const panePath = tab >= 0 ? line.slice(tab + 1) : '';
  return agentNameForPane(windowName, panePath);
}

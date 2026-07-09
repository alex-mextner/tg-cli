// Git-state-check banner (root-cause fix for the "silent task hijack" failure mode).
//
// tg-ctl routes an inbound message to a tmux PANE, not to "the agent's current task": a fresh,
// non-reply message can land in a pane that is mid-flight on unrelated feature work, and the pane
// — human or AI — has no signal that this is a NEW thread rather than a continuation of whatever
// it was just doing. It just reads as the next line of the same conversation and carries on.
//
// PURE, like discover.ts: raw `git` stdout strings in, structured data + banner text out. The
// tg-ctl entrypoint runs the actual `git rev-parse`/`git status --porcelain` spawns (timeout-
// guarded — a stuck git must never block the single-threaded poll loop) against the ALREADY-
// RESOLVED destination pane's cwd, and calls buildGitStateBanner with the parsed result right
// before injecting — never at spawn time (a freshly created pane has no prior work to protect).
//
// Honest limitation: this detects "the destination pane's cwd is mid-flight" (uncommitted changes
// or a non-main/master branch), NOT "this message is about a different task" — those are not the
// same thing. An agent that always works on a feature branch will see this banner on every
// delivery to that pane; that is expected noise from the check's design, not a bug. See the PR
// description for the tradeoff and the `control.git_state_banner` toggle to opt out.

export interface PaneGitState {
  branch: string; // '' when undeterminable (detached HEAD, or the entrypoint couldn't resolve one)
  uncommittedCount: number; // number of lines in `git status --porcelain`
}

const MAIN_BRANCHES = new Set(['main', 'master']);

// A pane counts as "occupied with feature work" when it has uncommitted changes OR sits on a
// branch other than main/master — a clean checkout of a feature branch is still someone's
// deliberate work in progress, even with nothing staged right now.
export function isPaneOccupiedWithWork(state: PaneGitState): boolean {
  return state.uncommittedCount > 0 || (state.branch !== '' && !MAIN_BRANCHES.has(state.branch));
}

// `git status --porcelain`: one non-empty line per changed/staged/untracked file.
export function parseUncommittedCount(statusPorcelainOut: string): number {
  return statusPorcelainOut.split('\n').filter((line) => line.trim() !== '').length;
}

// `git rev-parse --abbrev-ref HEAD`: the branch name, or the literal string 'HEAD' on a detached
// checkout — normalized to '' (not a branch name we can usefully name in a warning).
export function parseBranch(revParseOut: string): string {
  const trimmed = revParseOut.trim();
  return trimmed === 'HEAD' ? '' : trimmed;
}

export function buildPaneGitState(revParseOut: string, statusPorcelainOut: string): PaneGitState {
  return { branch: parseBranch(revParseOut), uncommittedCount: parseUncommittedCount(statusPorcelainOut) };
}

export const BANNER_ADVICE =
  'Routing check: if this message is about another project, clarify with the user before taking it here. If it clarifies an active task, route it to that active subagent. If it is a new task, start a new subagent.';

// The banner text prepended to an inbound message before it is injected into a pane that already
// has feature work in flight — so neither a human nor an AI agent silently treats an unrelated new
// message as "more of the same task". Returns null when the state is undeterminable (not a git
// repo, git missing, spawn failed/timed out — the entrypoint passes null straight through) or the
// pane is clean on main/master: the common "nothing in flight" case, byte-identical to no banner.
export function buildGitStateBanner(state: PaneGitState | null): string | null {
  if (!state || !isPaneOccupiedWithWork(state)) return null;
  // An empty branch only reaches here via the uncommittedCount>0 arm below (isPaneOccupiedWithWork
  // requires a non-empty, non-main branch to trigger on branch alone) — and it only means a
  // DETACHED HEAD: parseBranch already turned a successful `git rev-parse` into either a real
  // branch name or '' for the literal 'HEAD' output. Name it plainly rather than rendering
  // "branch  (1 file changed)" with the name silently missing (review catch).
  const branchLabel = state.branch || 'a detached HEAD';
  if (state.uncommittedCount > 0) {
    const files = `${state.uncommittedCount} file${state.uncommittedCount === 1 ? '' : 's'} changed`;
    return `⚠ This pane currently has uncommitted work on ${branchLabel === 'a detached HEAD' ? branchLabel : `branch ${branchLabel}`} (${files}). ${BANNER_ADVICE}`;
  }
  // Clean tree, but not on main/master: still someone's deliberate feature-branch checkout.
  // (branchLabel is always a real branch name here — see the comment above.)
  return `⚠ This pane is currently on branch ${branchLabel} (not main/master, tree clean). ${BANNER_ADVICE}`;
}

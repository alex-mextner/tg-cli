// Once-only hint bookkeeping for the autolink-tasks feature (spec §CLI
// missing / not authenticated → hint ONCE). Pure string→state→string helpers;
// the tg entrypoint owns the file I/O (~/.config/tg-cli/autolink-tasks.json)
// and treats every failure as "no state" / "don't persist" — a hint shown
// twice is annoying, a send blocked by hint bookkeeping is a bug.

export interface HintState {
  // autolink-tasks (Linear CLI) hints.
  install?: boolean;
  login?: boolean;
  // autolink-prs (gh CLI) hints. Shared state file, same once-only contract.
  'gh-install'?: boolean;
  'gh-login'?: boolean;
}

export type HintKind = keyof HintState;

// The set of recognized hint keys, so the parser stays backward-compatible (an
// old {install,login} file still parses) while accepting the gh kinds.
const HINT_KINDS: HintKind[] = ['install', 'login', 'gh-install', 'gh-login'];

/** Parse the persisted state; anything unreadable or non-object → empty. */
export function parseHintState(raw: string | null): HintState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: HintState = {};
    for (const kind of HINT_KINDS) {
      if ((parsed as HintState)[kind] === true) out[kind] = true;
    }
    return out;
  } catch {
    return {};
  }
}

export function markHint(state: HintState, kind: HintKind): HintState {
  return { ...state, [kind]: true };
}

export function serializeHintState(state: HintState): string {
  return JSON.stringify(state);
}

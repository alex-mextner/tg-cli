// Once-only hint bookkeeping for the autolink-tasks feature (spec §CLI
// missing / not authenticated → hint ONCE). Pure string→state→string helpers;
// the tg entrypoint owns the file I/O (~/.config/tg-cli/autolink-tasks.json)
// and treats every failure as "no state" / "don't persist" — a hint shown
// twice is annoying, a send blocked by hint bookkeeping is a bug.

export interface HintState {
  install?: boolean;
  login?: boolean;
}

export type HintKind = keyof HintState;

/** Parse the persisted state; anything unreadable or non-object → empty. */
export function parseHintState(raw: string | null): HintState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: HintState = {};
    if ((parsed as HintState).install === true) out.install = true;
    if ((parsed as HintState).login === true) out.login = true;
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

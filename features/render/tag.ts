// --- Message tag badge (`--tag <TAG>`) ---
//
// A small, well-known set of message tags agents use to label what a Telegram
// message IS (an answer, a decision, a problem report, a status report). Each
// canonical tag is Russian and renders as an emoji BADGE plus the tag word on
// the header line, right after `✳️ [window]`:
//
//   ✳️ [window] 🔵 💬 ОТВЕТ — <title>
//
// English aliases (ANSWER / DECISION / PROBLEM / REPORT) map onto the Russian
// canonicals; matching is case-insensitive. An UNKNOWN tag is not a hard error:
// it soft-renders as a plain `[TAG]` badge (uppercased) and a stderr note, so a
// typo never blocks a send.

// ---------------------------------------------------------------------------
// EDIT HERE — default emoji per canonical tag. The CTO may swap these freely;
// this is the ONE place the badge glyphs live. Keys are the canonical Russian
// tag words; values are the emoji badge shown before the tag word.
// ---------------------------------------------------------------------------
export const TAG_EMOJI: Record<string, string> = {
  ОТВЕТ: '🔵 💬',
  РЕШЕНИЕ: '🟠 ⚖️',
  ПРОБЛЕМА: '🔴 🚨',
  ОТЧЁТ: '🟢 📋',
};

// English aliases → canonical Russian tag. Case-insensitive (we uppercase the
// input before lookup). Russian canonicals also map to themselves so a
// case-insensitive Russian input ("ответ") still resolves.
const TAG_ALIASES: Record<string, string> = {
  ANSWER: 'ОТВЕТ',
  DECISION: 'РЕШЕНИЕ',
  PROBLEM: 'ПРОБЛЕМА',
  REPORT: 'ОТЧЁТ',
  ОТВЕТ: 'ОТВЕТ',
  РЕШЕНИЕ: 'РЕШЕНИЕ',
  ПРОБЛЕМА: 'ПРОБЛЕМА',
  ОТЧЁТ: 'ОТЧЁТ',
  // Tolerate the common "Ё→Е" spelling of ОТЧЁТ — agents type both.
  ОТЧЕТ: 'ОТЧЁТ',
};

export interface ResolvedTag {
  // The emoji badge to show before the word (e.g. "🔵 💬"). Empty for an
  // unknown tag (which renders as a bare `[WORD]`).
  emoji: string;
  // The tag WORD shown on the header line (the canonical Russian word for a
  // known tag; the uppercased raw input for an unknown one).
  word: string;
  // True when the input resolved to a canonical tag; false for an unknown tag
  // (the caller emits a one-line stderr note in that case but still sends).
  known: boolean;
}

/**
 * Resolve a raw `--tag` value to its badge. Case-insensitive; English aliases
 * map to the Russian canonicals. Never throws and never rejects: an unknown tag
 * resolves to `{ emoji: "", word: <UPPERCASED>, known: false }` so the caller
 * can soft-render `[TAG]` and warn rather than fail the send.
 */
export function resolveTag(raw: string): ResolvedTag {
  const key = raw.trim().toUpperCase();
  const canonical = TAG_ALIASES[key];
  if (canonical) {
    return { emoji: TAG_EMOJI[canonical], word: canonical, known: true };
  }
  return { emoji: '', word: key, known: false };
}

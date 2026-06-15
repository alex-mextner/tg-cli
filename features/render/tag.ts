// --- Message tag badge (`--tag <TAG>`) ---
//
// A small, well-known set of message tags agents use to label what a Telegram
// message IS (an answer, a decision, a problem report, a status report). Each
// canonical tag is the ENGLISH word and renders as a wordmark PILL (a custom
// emoji chip) plus, for non-premium / not-yet-uploaded viewers, a unicode
// fallback badge on the header line, right after `✳️ [window]`:
//
//   ✳️ [window] 🔵 ANSWER — <title>        (unicode fallback)
//   ✳️ [window] <ANSWER pill> — <title>    (premium, real pill ids uploaded)
//
// Russian aliases (ОТВЕТ / РЕШЕНИЕ / ПРОБЛЕМА / ОТЧЁТ) map onto the English
// canonicals; matching is case-insensitive. An UNKNOWN tag is not a hard error:
// it soft-renders as a plain `[TAG]` badge (uppercased) and a stderr note, so a
// typo never blocks a send.

import { TAG_PILL_DOT, TAG_PILL_FALLBACK, tagPillCellDots } from '../branding/emoji';

// The four canonical (English) tag words. This is the canonical order the pill
// set, the fallback map, and the upload script all key on.
export const CANONICAL_TAGS = ['ANSWER', 'DECISION', 'PROBLEM', 'REPORT'] as const;
export type CanonicalTag = (typeof CANONICAL_TAGS)[number];

// Aliases → canonical (English) tag. Case-insensitive (we uppercase the input
// before lookup). Both the English canonicals and the Russian words map here;
// the English canonical always maps to itself so case-insensitive English
// input ("answer") still resolves.
const TAG_ALIASES: Record<string, CanonicalTag> = {
  // English canonicals (self-mapping)
  ANSWER: 'ANSWER',
  DECISION: 'DECISION',
  PROBLEM: 'PROBLEM',
  REPORT: 'REPORT',
  // Russian aliases → English canonical
  ОТВЕТ: 'ANSWER',
  РЕШЕНИЕ: 'DECISION',
  ПРОБЛЕМА: 'PROBLEM',
  ОТЧЁТ: 'REPORT',
  // Tolerate the common "Ё→Е" spelling of ОТЧЁТ — agents type both.
  ОТЧЕТ: 'REPORT',
};

export interface ResolvedTag {
  // The unicode fallback badge to show before/instead of the pill (e.g.
  // "🔵 ANSWER"). Empty for an unknown tag (which renders as a bare `[WORD]`).
  // This is what non-premium viewers (and any viewer while the pill ids are
  // still placeholders) see.
  fallback: string;
  // The colored DOT alone (e.g. "🔵"), the tag's identifying glyph: the leading
  // glyph of `fallback` and the FIRST pill cell's inner fallback. Empty for an
  // unknown tag.
  dot: string;
  // The per-CELL inner fallbacks for the real <tg-emoji> pill, in cell order:
  // cell 0 = the colored `dot`, cells 1..n-1 = the neutral square (`▫️`). So a
  // push notification shows one colored dot + neutrals (e.g. `🔵▫️▫️`) instead of
  // N identical color dots. Empty for an unknown tag. Each entry MUST equal that
  // cell's Telegram-side alt (emoji_list) or Telegram drops the entity.
  cellDots: string[];
  // The canonical (English) tag WORD. For a known tag this is one of
  // ANSWER/DECISION/PROBLEM/REPORT; for an unknown tag it is the uppercased raw
  // input (and `known` is false).
  word: string;
  // True when the input resolved to a canonical tag; false for an unknown tag
  // (the caller emits a one-line stderr note in that case but still sends).
  known: boolean;
}

/**
 * Resolve a raw `--tag` value to its canonical English tag + unicode fallback
 * badge. Case-insensitive; Russian aliases map to the English canonicals. Never
 * throws and never rejects: an unknown tag resolves to
 * `{ fallback: "", word: <UPPERCASED>, known: false }` so the caller can
 * soft-render `[TAG]` and warn rather than fail the send.
 */
export function resolveTag(raw: string): ResolvedTag {
  const key = raw.trim().toUpperCase();
  const canonical = TAG_ALIASES[key];
  if (canonical) {
    return {
      fallback: TAG_PILL_FALLBACK[canonical],
      dot: TAG_PILL_DOT[canonical],
      cellDots: tagPillCellDots(canonical),
      word: canonical,
      known: true,
    };
  }
  return { fallback: '', dot: '', cellDots: [], word: key, known: false };
}

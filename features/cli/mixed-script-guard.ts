// Mixed-script "garbage token" guard (part of feature `cjk-guard`, ON by default).
//
// WHAT: catch a homoglyph / mojibake "garbage word" — a single CONTIGUOUS run of
// letters where a foreign alphabet (Latin, Greek, …) is SANDWICHED inside
// Cyrillic. The shape an LLM occasionally emits is a Cyrillic word with a few
// Latin homoglyphs stuck into the MIDDLE, e.g. "почčesна" (Cyrillic по + Latin
// čes + Cyrillic на) where it meant "починена". Reached from the `tg` entrypoint
// alongside the stray-CJK guard, on the FINAL decoded caption and the --title
// header, right before send; a hit is a HARD error (exit 1) so the sender
// re-sends clean. Off-switch: `--no-feature cjk-guard` (same toggle as the CJK
// guard — both catch the same "a garbled token slipped into the message" class).
//
// INVARIANT: precision over recall, and fire ONLY on INTERLEAVING within ONE run.
// The mojibake signature is a foreign fragment BETWEEN Cyrillic — i.e. the run's
// script switches TWICE OR MORE (`…Cyr → Lat → Cyr…`). We count script
// transitions and flag only runs with >= 2. That is what separates garble from
// the many LEGITIMATE two-segment tokens Russian dev writing produces:
//   * a message using both scripts across DIFFERENT words ("влил PR", "gh ship
//     готово", "dev-cli") — each word is one run, one script, zero transitions;
//   * a Latin acronym HYPHEN-joined to a Cyrillic word ("PR-ревью", "MCP-сервер")
//     — the hyphen is a non-letter, so the two scripts are in SEPARATE runs;
//   * a Latin acronym with a GLUED Cyrillic case/diminutive suffix and no
//     separator ("IDшник", "PRы", "APIшка", "ORMка") — ONE run but only ONE
//     boundary (Latin → Cyrillic), so it is NOT the mid-word sandwich and passes.
// Requiring >= 2 transitions is the whole reason those glued compounds survive.
//
// SCOPE: the "foreign" partner is any cased/other letter that is neither Cyrillic
// nor CJK (Latin, Greek, Armenian, …). CJK letters are IGNORED entirely — they do
// not vote on script AND do not create a transition — so this guard measures pure
// Cyrillic<->foreign interleaving and stays STRUCTURALLY orthogonal to the
// stray-CJK guard (features/cli/cjk-guard.ts, whose `isCjk` we reuse so the two
// can't drift), rather than relying on CLI firing order. A run is flagged only
// when its Cyrillic/foreign letters contain BOTH a Cyrillic AND a foreign letter
// with >= 2 transitions between them; Cyrillic + digits / punctuation / emoji is
// not mixing and passes. Combining marks (\p{M}) and modifier letters (\p{Lm},
// e.g. a lone U+02BC used in some Cyrillic-script orthographies) are part of the
// run but do NOT vote, so a decomposed accent or a modifier letter cannot
// fabricate a transition. Residual recall gap (accepted, same escape hatch as the
// CJK guard): a garble with the foreign fragment at a run EDGE (one transition)
// reads identically to a legit glued compound and is left alone — use
// `--no-feature cjk-guard` for the rare legitimately-mixed token.

import { isCjk } from './cjk-guard';

// A codepoint that participates in a letter "run": a letter (\p{L}) or a
// combining mark (\p{M}). Marks attach to the preceding letter, so a decomposed
// accent must not split a run.
const LETTERISH_RE = /[\p{L}\p{M}]/u;
const LETTER_RE = /\p{L}/u;
// A modifier letter (Lm) is a letter but is not part of the base alphabet — treat
// it like a combining mark: it rides in the run but does not vote on script.
const MODIFIER_LETTER_RE = /\p{Lm}/u;
const CYRILLIC_RE = /\p{sc=Cyrillic}/u;

// The voting script "class" of a base letter, for transition counting. Non-voting
// codepoints (non-letters, combining marks, modifier letters, and CJK letters —
// the stray-CJK guard's domain) return null and are skipped entirely.
type ScriptClass = 'cyrillic' | 'foreign';

export interface MixedScriptToken {
  token: string; // the offending contiguous letter run
  index: number; // 0-based codepoint index of the run's first char in the message
}

export interface MixedScriptFinding {
  tokens: MixedScriptToken[];
}

function isLetterish(ch: string): boolean {
  return LETTERISH_RE.test(ch);
}

// Classify a codepoint's voting script, or null when it does not vote (a
// non-letter, a combining mark, a modifier letter, or a CJK letter — CJK is the
// stray-CJK guard's domain and is skipped so it neither votes nor transitions).
function scriptClassOf(ch: string): ScriptClass | null {
  if (!LETTER_RE.test(ch) || MODIFIER_LETTER_RE.test(ch)) return null;
  if (isCjk(ch)) return null;
  return CYRILLIC_RE.test(ch) ? 'cyrillic' : 'foreign';
}

// A letter run [start, end) is "garbage" when its voting letters contain BOTH
// Cyrillic and foreign AND the script switches at least twice — the mojibake
// "foreign fragment sandwiched inside Cyrillic" signature. A single boundary
// (Latin acronym + glued Cyrillic suffix, e.g. `IDшник`) is a legit compound.
function runIsGarbage(codepoints: string[], start: number, end: number): boolean {
  let hasCyrillic = false;
  let hasForeign = false;
  let transitions = 0;
  let prev: ScriptClass | null = null;
  for (let i = start; i < end; i += 1) {
    const cls = scriptClassOf(codepoints[i]);
    if (cls === null) continue;
    if (cls === 'cyrillic') hasCyrillic = true;
    else if (cls === 'foreign') hasForeign = true;
    if (prev !== null && cls !== prev) transitions += 1;
    prev = cls;
  }
  return hasCyrillic && hasForeign && transitions >= 2;
}

/**
 * Find contiguous letter runs where a foreign alphabet is sandwiched inside
 * Cyrillic — the homoglyph/mojibake "garbage word" bug. Returns null when clean.
 */
export function findMixedScriptTokens(text: string): MixedScriptFinding | null {
  const codepoints = Array.from(text);
  const tokens: MixedScriptToken[] = [];
  let i = 0;
  while (i < codepoints.length) {
    if (!isLetterish(codepoints[i])) {
      i += 1;
      continue;
    }
    // Consume the maximal run of letters (+ attached combining marks).
    const start = i;
    while (i < codepoints.length && isLetterish(codepoints[i])) i += 1;
    if (runIsGarbage(codepoints, start, i)) {
      tokens.push({ token: codepoints.slice(start, i).join(''), index: start });
    }
  }
  return tokens.length > 0 ? { tokens } : null;
}

/** A human-actionable error naming each offending token and its position. */
export function formatMixedScriptError(finding: MixedScriptFinding): string {
  const list = finding.tokens
    .map((t) => `'${t.token}' at position ${t.index + 1}`)
    .join(', ');
  return (
    `mixed-script "garbage" token — a single word mixes Cyrillic with Latin/other ` +
    `letters (the homoglyph/mojibake signature): ${list}. This usually means a ` +
    `garbled token slipped into the message — re-send a clean copy. To send it ` +
    `anyway, pass --no-feature cjk-guard.`
  );
}

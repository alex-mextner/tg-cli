// Stray-CJK guard (feature `cjk-guard`, ON by default).
//
// WHAT: catch isolated CJK / ideographic codepoints an LLM occasionally emits
// stuck INTO otherwise Latin/Cyrillic text — the "hieroglyph in a normal word"
// bug (e.g. "ка<CJK>eat", "<CJK>ляет"). Reached from the `tg` entrypoint, which
// runs it on the FINAL decoded caption (and the --title header) right before
// send and hard-errors (exit 1) on a hit, so the sender re-sends clean.
// Off-switch: `--no-feature cjk-guard`.
//
// INVARIANT: precision over recall. We flag a LONE ideograph — a CJK run of
// exactly ONE codepoint — only when a Latin/Cyrillic LETTER IMMEDIATELY FOLLOWS
// it. That is the exact shape of the bug: the ideograph splits or prefixes a
// word, so the token continues in Latin/Cyrillic straight after the hieroglyph
// (`ка日|eat`, `注|ляет`). Requiring the letter on the RIGHT — not merely either
// side — is deliberate: it clears the whole false-positive class of a legit CJK
// SUFFIX/particle glued to a Latin token, where the CJK ends the token (space or
// end-of-string follows), e.g. Korean `React를 배포` / `iOS版`, Japanese `APIを`.
// A multi-codepoint CJK run is a genuine bilingual word (`Deploy到生产`, `3D打印`)
// and never flagged; a genuinely CJK message (dominant script is CJK) short-
// circuits untouched; emoji and accented Latin are not CJK. Residual recall gap
// (accepted): a lone CJK at a token's END (`deploy日 done`) reads identically to
// a legit suffix and is left alone, and a heavily CJK garble that crosses the
// dominance line is treated as a CJK message. Residual false positive (accepted):
// this is plain-text only — it does not parse Markdown/HTML, so a garble QUOTED
// in inline code is flagged like a real one; `--no-feature cjk-guard` is the
// escape.

// CJK "hieroglyph" scripts: Han (Chinese ideographs), Japanese kana, Korean
// Hangul. Deliberately NOT including CJK symbols/punctuation or fullwidth forms
// — those are not the "ideograph stuck in a word" failure mode.
const CJK_RE = /\p{sc=Han}|\p{sc=Hiragana}|\p{sc=Katakana}|\p{sc=Hangul}/u;
const LATIN_CYRILLIC_LETTER_RE = /[\p{sc=Latin}\p{sc=Cyrillic}]/u;

// A message is "substantially CJK" (legitimate, leave it) when CJK codepoints
// are at least this SHARE of its script-bearing characters AND there are at
// least this MANY of them in absolute terms. The absolute floor matters: without
// it a tiny message like `日a` is 50% CJK and would short-circuit as "dominant",
// hiding exactly the short garble the guard targets. A genuine CJK message has
// several ideographs, so the floor separates "real CJK text" from "a stray char
// in a 2-3 char fragment".
const CJK_DOMINANT_FRACTION = 0.5;
const CJK_DOMINANT_MIN_COUNT = 3;

export interface StrayCjkChar {
  char: string;
  codepoint: number; // Unicode scalar value
  index: number; // 0-based codepoint index within the message
}

export interface StrayCjkFinding {
  chars: StrayCjkChar[];
}

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

function isLatinCyrillicLetter(ch: string): boolean {
  return LATIN_CYRILLIC_LETTER_RE.test(ch);
}

// True when the message's dominant script is CJK — a legitimate CJK message we
// must not touch. Compares CJK against Latin/Cyrillic script-bearing chars only
// (spaces, digits, punctuation, emoji don't vote).
function isCjkDominant(codepoints: string[]): boolean {
  let cjk = 0;
  let latinCyrillic = 0;
  for (const ch of codepoints) {
    if (isCjk(ch)) cjk += 1;
    else if (isLatinCyrillicLetter(ch)) latinCyrillic += 1;
  }
  if (cjk < CJK_DOMINANT_MIN_COUNT) return false;
  const total = cjk + latinCyrillic;
  return cjk / total >= CJK_DOMINANT_FRACTION;
}

// A codepoint that is a Latin/Cyrillic letter (undefined = string edge).
function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && isLatinCyrillicLetter(ch);
}

// A CJK run [start, end) is "stray" when it is exactly one codepoint long AND a
// Latin/Cyrillic letter immediately follows it — the ideograph splits/prefixes a
// word (`ка日eat`, `注ляет`). A longer run is a real CJK word; a lone CJK ending
// a token (letter before, space/end after) is a legit suffix and not flagged.
function isLoneStrayCjk(codepoints: string[], start: number, end: number): boolean {
  if (end - start !== 1) return false;
  return isLetter(codepoints[end]);
}

/**
 * Find lone CJK codepoints stuck mid-word inside otherwise Latin/Cyrillic text.
 * Returns null when the message is clean OR is a legitimately CJK message.
 */
export function findStrayCjk(text: string): StrayCjkFinding | null {
  const codepoints = Array.from(text);
  if (isCjkDominant(codepoints)) return null;

  const chars: StrayCjkChar[] = [];
  let i = 0;
  while (i < codepoints.length) {
    if (!isCjk(codepoints[i])) {
      i += 1;
      continue;
    }
    // Consume the maximal run of consecutive CJK codepoints.
    const start = i;
    while (i < codepoints.length && isCjk(codepoints[i])) i += 1;
    if (isLoneStrayCjk(codepoints, start, i)) {
      const ch = codepoints[start];
      chars.push({ char: ch, codepoint: ch.codePointAt(0) ?? 0, index: start });
    }
  }
  return chars.length > 0 ? { chars } : null;
}

function formatCodepoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** A human-actionable error naming each offending character and its position. */
export function formatStrayCjkError(finding: StrayCjkFinding): string {
  const parts = finding.chars.map(
    (c) => `'${c.char}' (${formatCodepoint(c.codepoint)}) at position ${c.index + 1}`,
  );
  const list = parts.join(', ');
  return (
    `stray CJK / ideographic character stuck into non-CJK text: ${list}. ` +
    `This usually means a garbled token slipped into the message — re-send a clean copy. ` +
    `To send it anyway, pass --no-feature cjk-guard.`
  );
}

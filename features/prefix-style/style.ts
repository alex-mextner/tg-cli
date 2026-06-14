// Unicode + HTML styling for the outbound message prefix
// (docs/specs/unicode-prefix-styling.md).
//
// Two independent stylers, both PURE:
//   - the tmux window name inside [] → Mathematical Sans-Serif Bold
//     (𝗮𝗽𝗶-𝗯𝗼𝘁), "math but no serifs";
//   - the single-ticket task title appended after [] → Mathematical Bold
//     Italic (𝑭𝒊𝒙 𝒂𝒖𝒕𝒐𝒍𝒊𝒏𝒌), a serif italic.
//
// The Mathematical Alphanumeric Symbols blocks only cover ASCII A-Z/a-z (and,
// for sans-serif, digits). Cyrillic and other non-Latin letters have NO glyph
// there, so a token that contains one falls back to a real HTML tag (<b>/<i>)
// instead — exactly the fallback the user asked for. Digits and punctuation
// never trigger the fallback: they are left verbatim inside an otherwise styled
// token (Bold Italic has no digit glyphs, so "Fix v2" keeps its plain 2).

// --- Mathematical Alphanumeric block bases ---
const SANS_BOLD_UPPER = 0x1d5d4; // 'A' → 𝗔
const SANS_BOLD_LOWER = 0x1d5ee; // 'a' → 𝗮
const SANS_BOLD_DIGIT = 0x1d7ec; // '0' → 𝟬
const BOLD_ITALIC_UPPER = 0x1d468; // 'A' → 𝑨
const BOLD_ITALIC_LOWER = 0x1d482; // 'a' → 𝒂

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A letter we cannot render in a Mathematical block: any Unicode letter that is
// not ASCII A-Z/a-z (Cyrillic, accented Latin, Greek, …). Its presence forces
// the whole token onto the HTML-tag fallback so the styling stays consistent —
// a half-styled "𝓟очинить" would look broken.
function hasForeignLetter(s: string): boolean {
  for (const ch of s) {
    if (/\p{L}/u.test(ch) && !/[A-Za-z]/.test(ch)) return true;
  }
  return false;
}

// Map ASCII letters (and, when `digitBase` is given, digits) of `s` to the
// chosen Mathematical block; leave every other code point verbatim. Returns
// null when `s` carries a letter the block can't represent — the caller then
// uses the HTML fallback.
function styleLatin(
  s: string,
  upperBase: number,
  lowerBase: number,
  digitBase?: number,
): string | null {
  if (hasForeignLetter(s)) return null;
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x41 && c <= 0x5a) out += String.fromCodePoint(upperBase + (c - 0x41));
    else if (c >= 0x61 && c <= 0x7a) out += String.fromCodePoint(lowerBase + (c - 0x61));
    else if (digitBase !== undefined && c >= 0x30 && c <= 0x39)
      out += String.fromCodePoint(digitBase + (c - 0x30));
    else out += ch;
  }
  return out;
}

// Mathematical Sans-Serif Bold (letters + digits). null → has a foreign letter.
export function toSansBold(s: string): string | null {
  return styleLatin(s, SANS_BOLD_UPPER, SANS_BOLD_LOWER, SANS_BOLD_DIGIT);
}

// Mathematical Bold Italic (letters only — the block has no digits). null →
// has a foreign letter.
export function toBoldItalic(s: string): string | null {
  return styleLatin(s, BOLD_ITALIC_UPPER, BOLD_ITALIC_LOWER);
}

export interface StyledToken {
  html: string; // HTML-ready form (escaped; may carry a <b>/<i> tag)
  plain: string; // plain-text form (raw; no escaping, no tag)
  tag: boolean; // true when `html` carries a real tag → render MUST be HTML
}

// Style a tmux window NAME (the text inside []). Latin → Sans-Serif Bold; a
// Cyrillic/foreign name → <b>name</b>. The brackets themselves are added by the
// caller and stay unstyled.
export function styleWindowName(name: string): StyledToken {
  const uni = toSansBold(name);
  if (uni !== null) return { html: escapeHtml(uni), plain: uni, tag: false };
  return { html: `<b>${escapeHtml(name)}</b>`, plain: name, tag: true };
}

// Style a task TITLE (the autolink single-ticket title shown after []). Returns
// final HTML (already escaped). Latin → Bold Italic unicode; a title that
// carries any Cyrillic/foreign letter falls back WHOLE to <i>title</i> (the
// math block has no Cyrillic). Suitable as the `styleTitle` hook of applyAutolink.
export function styleTaskTitle(raw: string): string {
  const uni = toBoldItalic(raw);
  if (uni !== null) return escapeHtml(uni);
  return `<i>${escapeHtml(raw)}</i>`;
}

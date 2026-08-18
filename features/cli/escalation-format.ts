// --- Full escalation-format validator (--tag decision|question) ---
//
// WHAT THIS IS
//   The machine-checkable half of the `decision-request-discipline` skill. A
//   `--tag decision` / `--tag question` send is an ESCALATION: it asks the human
//   (CTO) to choose. The skill mandates a self-contained request the human can
//   answer in ~30s WITHOUT opening the repo — Context, Options with real
//   pros/cons, a Recommendation, and "where to look" (a file:line reference),
//   presented as a real table or list (not a prose paragraph the human must
//   re-derive). Before this, `tg` only WARNED (and only checked for a bare
//   table, only under an opt-in env). This validator enforces the FORMAT
//   deny-by-default (see `escalationGateEnforced`, now ON by default).
//
// WHY HEURISTIC (and bilingual)
//   The body is free-form and usually RUSSIAN (the CTO's language). There is no
//   structured schema to validate, so each required section is detected by a
//   generous bilingual signal. The checks bias toward FALSE POSITIVES (letting a
//   borderline-but-real request through) over FALSE NEGATIVES (blocking a
//   genuine escalation and wedging the agent): the documented escape
//   `ESCALATION_GATE_ENFORCE=0` exists for the rare genuine edge case. The error
//   lists EXACTLY which sections are missing so the caller can fix and resend.
//
// PURE — no I/O. Consumed by features/cli/args.ts (parse-time gate) and mirrored
// by the pre-send-text hook.

import { detectTableKind } from '../render/table';

export interface EscalationFormatResult {
  ok: boolean;
  // Human-readable labels of the missing required sections, in skill order.
  missing: string[];
}

// A recommendation: "which option I'd pick and why". Bilingual.
const RECOMMENDATION_RE =
  /\b(recommend|recommendation|i (?:suggest|propose)|my pick|i'?d pick|i would (?:pick|go with)|lean(?:ing)? toward)\b|рекоменд|предлаг|советую|склоня|выбрал бы|мой выбор|остановил бы|пошёл бы|пошел бы/iu;

// Pros/cons / tradeoffs attached to the options. Bilingual.
const PROS_CONS_RE =
  /\b(pros?|cons?|trade[- ]?offs?|advantages?|disadvantages?|upsides?|downsides?|benefits?|drawbacks?)\b|плюс|минус|компромисс|преимуществ|недостат|за и против|риск/iu;

// A file / code reference: `foo.ts`, `path/bar.py:42`, `a/b/c`. Precise enough
// that ordinary prose ("e.g.", "i.e.") does not match: a known code extension
// (optionally with :line), a slashed path, or a bare `name:line`.
const FILE_REF_RE =
  /\b[\w.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|ya?ml|md|sh|sql|toml|css|scss|html?|vue|svelte|c|cc|cpp|h|hpp|java|rb|php|swift|kt)\b(?::\d+)?|\b[\w-]+\/[\w./-]+|\b[\w.-]+:\d+\b/iu;

// A <ul>/<ol>/<li> list — the structural alternative to a table for options.
const LIST_RE = /<(?:ul|ol|li)\b/iu;
const LI_RE = /<li\b/giu;
// Section headings (Rich Message) — the readability requirement.
const HEADING_RE = /<h[1-6]\b/giu;
const HR_RE = /<hr\b/iu;

// A "wall of text": run-on prose with no structure. Two shapes, both what the
// CTO flagged (tg#8970 — an 8-point message that was still "very hard to read"):
//   1. A single non-markup line longer than WALL_LINE_CHARS (a run-on paragraph).
//   2. An inline comma-run enumeration after a pros/cons label on ONE line
//      ("плюсы: a, b, c, d") instead of a <ul> of one-line items.
const WALL_LINE_CHARS = 350;
const INLINE_ENUM_RE =
  /(?:pros?|cons?|плюсы|минусы|преимуществ\w*|недостат\w*)\s*[:：].*?,.*?,.*?,/iu;

// Block-level HTML tags that Telegram renders as a visual line break
// regardless of whether the source string contains a literal `\n` there
// (tg-cli#261: a fully-structured Rich Message typed as one continuous
// string, with no literal newline between sections, was misdiagnosed as a
// wall of text purely because its RAW string had no newlines — every
// section still renders on its own line in Telegram). The break goes
// BEFORE an opening tag and AFTER a closing/void tag — never splitting an
// element from its own tags — so `<li>…</li>` stays one line and the
// skip-list below (which matches a line's STARTING tag, e.g. `<li`) keeps
// excluding it exactly as it did for a literal-newline body.
const OPEN_BLOCK_RE = /<(?:h[1-6]|p|tr|li|table|ul|ol|blockquote|pre)\b[^>]*>/giu;
const CLOSE_BLOCK_RE = /<\/(?:h[1-6]|p|tr|li|table|ul|ol|blockquote|pre)\s*>|<(?:hr|br)\b[^>]*\/?>/giu;
function withVisualLineBreaks(body: string): string {
  return body.replace(OPEN_BLOCK_RE, (tag) => `\n${tag}`).replace(CLOSE_BLOCK_RE, (tag) => `${tag}\n`);
}
function hasWallOfText(body: string): boolean {
  for (const raw of withVisualLineBreaks(body).split('\n')) {
    const line = raw.trim();
    // INLINE_ENUM_RE runs on every visual line BEFORE the skips below (same
    // as the original whole-body check): an inline "Плюсы: a, b, c," is
    // still the pattern this exists to catch even inside a <li> or a
    // markdown table row. Scoping it to one visual line (rather than the
    // raw, possibly newline-free body) is what stops it from matching
    // across unrelated sections of a one-line body — see tg-cli#261.
    if (INLINE_ENUM_RE.test(line)) return true;
    if (line.includes('|')) continue; // table row
    if (/^<\/?(?:table|tr|td|th|ul|ol|li|thead|tbody|caption|pre|code|blockquote)\b/iu.test(line)) continue;
    if (/[│┌┬┐└┴┘├┼┤─]/u.test(line)) continue; // boxed table
    if (line.length > WALL_LINE_CHARS) return true;
  }
  return false;
}

// A body has explanatory PROSE (the Context requirement) when at least one line
// is not part of a table/list markup and carries real words (>= 20 chars).
function hasContextProse(body: string): boolean {
  // Same tg-cli#261 normalization as hasWallOfText: without it, a one-line
  // structured body is a single "line" that starts with `<h3` (not in the
  // skip-list below) and the word count runs over the WHOLE glued body
  // including tag names ("h", "3", "C", "o", "n", "t", "e", "x", "t", …),
  // trivially clearing 20 chars from markup alone — auto-passing Context
  // with zero real prose, while the same content with literal newlines
  // correctly fails. Caught in review of this same PR.
  for (const raw of withVisualLineBreaks(body).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.includes('|')) continue; // markdown pipe / boxed table row
    if (/^<\/?(?:table|tr|td|th|ul|ol|li|thead|tbody|caption|blockquote|pre|code)\b/iu.test(line)) continue;
    if (/[│┌┬┐└┴┘├┼┤─]/u.test(line)) continue; // boxed-table glyphs
    // Count word characters so a divider line ("-----") is not "prose".
    const words = (line.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (words >= 20) return true;
  }
  return false;
}

/**
 * Validate a decision/question body against the decision-request-discipline
 * format. Returns `ok:true` with an empty `missing` when every required section
 * is present, else `ok:false` and the labels of what's missing (skill order).
 */
export function validateEscalationFormat(body: string): EscalationFormatResult {
  const missing: string[] = [];
  const text = body ?? '';

  const hasTable = detectTableKind(text) !== 'none';
  const hasList = LIST_RE.test(text);
  // Options must be a genuine multi-option structure: a table, or a list with
  // >=2 items. A single bullet (e.g. a recommendation-only <ul><li>…</li></ul>)
  // is NOT an options section — it must not satisfy this on its own.
  const listItemCount = (text.match(LI_RE) ?? []).length;
  const hasOptionsStructure = hasTable || listItemCount >= 2;
  if (!hasOptionsStructure) {
    missing.push('Options as a real table (<table> / markdown pipe grid / tg --table) or a <ul>/<ol> list of >=2 options');
  }
  if (!PROS_CONS_RE.test(text)) {
    missing.push('Pros/cons (tradeoffs) for each option — "плюсы/минусы", pros/cons');
  }
  if (!RECOMMENDATION_RE.test(text)) {
    missing.push('A recommendation (which option you’d pick and why) — "рекомендация"');
  }
  // A concrete file / code reference is REQUIRED — a bare "where to look" phrase
  // with no actual pointer is useless to the reviewer.
  if (!FILE_REF_RE.test(text)) {
    missing.push('Where to look — a concrete file reference (e.g. features/foo.ts:42) — "где смотреть"');
  }
  if (!hasContextProse(text)) {
    missing.push('Context — a sentence of prose on where the code is and what it does');
  }

  // --- Readability / structure (CTO tg#8970): an 8-point message that follows
  // the content format is STILL unacceptable if it is a "wall of text". A
  // compliant escalation is a STRUCTURED Rich Message: each section under its
  // own heading, enumerations as short bullet items, dividers between sections.
  if ((text.match(HEADING_RE) ?? []).length < 2) {
    missing.push('Structure — put each section under its own <h3>/<h4> heading (needs --format html; ≥2 headings)');
  }
  if (!hasList) {
    missing.push('Structure — use <ul>/<ol> bullet lists for pros/cons and enumerations (one short item per <li>, never inline "плюсы: a, b, c")');
  }
  if (!HR_RE.test(text)) {
    missing.push('Structure — separate sections with <hr> dividers');
  }
  if (hasWallOfText(text)) {
    missing.push('Readability — break run-on paragraphs: short lines, one idea per bullet (no long dense paragraph, no inline comma-run enumeration)');
  }

  return { ok: missing.length === 0, missing };
}

// The copy-pasteable guidance appended when a decision/question send is
// malformed. Shared by the parse-time gate and the pre-send-text hook so the two
// never drift.
export function escalationFormatMessage(tag: string, missing: string[]): string {
  const bullets = missing.map((m) => `  • ${m}`).join('\n');
  return (
    `--tag ${tag} is an escalation and must follow the decision-request format ` +
    `(skill: decision-request-discipline) as a STRUCTURED Rich Message, so the CTO can ` +
    `answer in ~30s without opening the repo AND without reading a wall of text. ` +
    `Missing:\n${bullets}\n` +
    `Use --format html with this shape (markdown pipe grids are auto-converted to a <table>):\n` +
    `<h3>Context</h3><p>features/foo.ts:42 does X.</p><hr>\n` +
    `<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>` +
    `<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>\n` +
    `<h3>Recommendation</h3><ul><li>A — because …</li></ul><hr>\n` +
    `<h3>Where to look</h3><ul><li>features/foo.ts:42</li></ul>`
  );
}

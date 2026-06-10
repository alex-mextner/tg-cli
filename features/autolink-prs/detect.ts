// GitHub-reference detection for the autolink-prs feature (spec §Detection).
//
// A reference is `#` immediately followed by digits, written as one token
// (#260). Whether the number is a real Issue or PR is the resolve.ts probe's
// job; this is pure text analysis. Mirrors features/autolink-tasks/detect.ts.

// One reference occurrence inside a token. The leading digit must be 1-9 (#0 is
// not a thing on GitHub). The boundary chars (before/after) must not be
// alphanumeric, so x#1 / #1a are not references while (#260), #260, and #260.
// are.
const REF_RE = /#[1-9][0-9]*/g;

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/**
 * Find reference occurrences in a single text segment (no tag/URL awareness —
 * the caller decides which segments are eligible). Returns [start, end, number]
 * triples for boundary-valid matches. Shared by detection and linkify so the two
 * can never disagree on what counts as a reference.
 */
export function findRefMatches(segment: string): Array<{ start: number; end: number; number: number }> {
  const out: Array<{ start: number; end: number; number: number }> = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(segment)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (isAlnum(segment[start - 1]) || isAlnum(segment[end])) continue;
    out.push({ start, end, number: parseInt(m[0].slice(1), 10) });
  }
  return out;
}

/**
 * Detect GitHub references (#N) in message text: unique by number,
 * first-appearance order. Whitespace-delimited tokens containing "://" (URLs)
 * are skipped entirely — a pasted GitHub URL contains the number in its path and
 * must not count as a plain-text mention.
 */
export function detectRefs(text: string): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const token of text.split(/\s+/)) {
    if (!token || token.includes('://')) continue;
    for (const { number } of findRefMatches(token)) {
      if (seen.has(number)) continue;
      seen.add(number);
      ordered.push(number);
    }
  }
  return ordered;
}

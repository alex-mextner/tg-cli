// Ticket-code detection for the autolink-tasks feature (spec §Detection).
//
// A ticket code is exactly 3 uppercase Latin letters, a dash, then digits,
// written as one token (HYP-576). Detection is pure text analysis — whether the
// code is a REAL Linear issue is the linear.ts probe's job.

// One code occurrence inside a token. The boundary chars (before/after) must
// not be alphanumeric, so XHYP-576 / HYP-576a are not codes while (HYP-576),
// HYP-576, and HYP-576. are.
const CODE_RE = /[A-Z]{3}-[0-9]+/g;

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

// A code embedded in a file-path-looking token (HYP-123.ts:10, src/HYP-123/x)
// is a FILE mention, not a ticket mention. Linkifying it would also break the
// line-spec quote anchor in tg, which searches for the path token as a
// contiguous string. A trailing sentence period (HYP-576.) is NOT pathish —
// only a separator followed by more word characters is.
function isPathish(segment: string, start: number, end: number): boolean {
  const before = segment[start - 1];
  if (before === '/' || before === '\\') return true;
  if (before === '.' && isAlnum(segment[start - 2])) return true;
  const after = segment[end];
  if ((after === '.' || after === '/' || after === '\\') && isAlnum(segment[end + 1])) return true;
  return false;
}

/**
 * Find code occurrences in a single text segment (no tag/URL awareness — the
 * caller decides which segments are eligible). Returns [start, end, code]
 * triples for boundary-valid, non-pathish matches. Shared by detection and
 * linkify so the two can never disagree on what counts as a code.
 */
export function findCodeMatches(segment: string): Array<{ start: number; end: number; code: string }> {
  const out: Array<{ start: number; end: number; code: string }> = [];
  CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_RE.exec(segment)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (isAlnum(segment[start - 1]) || isAlnum(segment[end])) continue;
    if (isPathish(segment, start, end)) continue;
    out.push({ start, end, code: m[0] });
  }
  return out;
}

/**
 * Detect ticket-like codes in message text: unique, first-appearance order.
 * Whitespace-delimited tokens containing "://" (URLs) are skipped entirely —
 * a pasted Linear URL contains the code in its path and must not count as a
 * plain-text mention.
 */
export function detectTicketCodes(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (!token || token.includes('://')) continue;
    for (const { code } of findCodeMatches(token)) {
      if (seen.has(code)) continue;
      seen.add(code);
      ordered.push(code);
    }
  }
  return ordered;
}

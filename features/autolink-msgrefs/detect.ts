// Inbound-message reference detection for the autolink-msgrefs feature (tg#28).
//
// A message reference is the literal `tg#<id>` token — the convention the
// inbound inject wrap renders (`[TG from Alex tg#1234] …`, see
// features/tg-ctl/inject.ts). An agent that quotes that id back in an outbound
// message ("answered tg#1234") means "the Telegram message with id 1234", NOT a
// GitHub issue/PR `#1234`.
//
// The `tg#` prefix is the whole point: a bare `#1234` is already claimed by
// autolink-prs (resolved against the cwd GitHub repo). Detecting `tg#<id>`
// FIRST — and consuming the token so the PR pass never sees a stray `#1234` —
// keeps the two ref namespaces from colliding (the ROADMAP requirement). In
// practice the PR detector's own boundary rule already rejects `tg#1234` (the
// `g` before `#` is alphanumeric), so the two are naturally disjoint; running
// msgrefs first and wrapping the token in an <a>/<b> the PR walker skips makes
// that disjointness explicit and robust to future loosening.
//
// PURE text analysis: no I/O. Mirrors features/autolink-prs/detect.ts in shape.

// `tg#` (case-insensitive on the ASCII `tg`) or the already-rendered
// Mathematical Bold Italic form (`𝒕𝒈#` / `𝑻𝑮#`) immediately followed by a
// positive id. The styled form exists because private-DM msgrefs render as
// marked-but-unlinked text; users often copy that back verbatim.
const MSGREF_RE = /(?:[tT][gG]|[𝑻𝒕][𝑮𝒈])#([1-9][0-9]*)/gu;

const ALNUM_RE = /[\p{L}\p{N}]/u;

function codePointBefore(segment: string, idx: number): string | undefined {
  if (idx <= 0) return undefined;
  const lo = segment.charCodeAt(idx - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && idx >= 2) {
    const hi = segment.charCodeAt(idx - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return segment.slice(idx - 2, idx);
  }
  return segment[idx - 1];
}

function codePointAt(segment: string, idx: number): string | undefined {
  if (idx >= segment.length) return undefined;
  const cp = segment.codePointAt(idx);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && ALNUM_RE.test(ch);
}

/**
 * Find `tg#<id>` occurrences in a single text segment. Returns
 * [start, end, id] triples for boundary-valid matches: the char AFTER the
 * number must not be alphanumeric (so `tg#12a` is not a ref), and the char
 * BEFORE `tg` must not be alphanumeric (so `xtg#12` is not a ref). Shared by
 * detection and linkify so the two can never disagree on what counts as a ref.
 */
export function findMsgRefMatches(segment: string): Array<{ start: number; end: number; id: number }> {
  const out: Array<{ start: number; end: number; id: number }> = [];
  MSGREF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MSGREF_RE.exec(segment)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (isAlnum(codePointBefore(segment, start)) || isAlnum(codePointAt(segment, end))) continue;
    out.push({ start, end, id: parseInt(m[1], 10) });
  }
  return out;
}

/**
 * Detect inbound-message references (`tg#<id>`) in message text: unique by id,
 * first-appearance order. Whitespace-delimited tokens containing "://" (URLs)
 * are skipped — a pasted URL that happens to contain `tg#…` in its path must
 * not count as a plain-text mention (same guard as autolink-prs).
 */
export function detectMsgRefs(text: string): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const token of text.split(/\s+/)) {
    if (!token || token.includes('://')) continue;
    for (const { id } of findMsgRefMatches(token)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

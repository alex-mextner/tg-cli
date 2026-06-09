// Line-spec snippet extraction (spec §Line-spec).
//
// HONEST SCOPE: a full AST per language is not feasible in a single Bun script.
// This module uses a LIGHT, brace/indent-aware heuristic, and degrades to plain
// line-based ±2 where no heuristic applies. Specifically:
//   - ts/tsx/js/jsx: brace-aware — after taking ±2 lines, extend the range
//     outward until curly braces balance (capped), so we don't cut a block in
//     half. This is NOT a real parser; it ignores braces inside strings/comments
//     (acceptable for a context-preview snippet — see docs/specs/auto-attach.md).
//   - py: indent-aware — extend to include the full indented suite the target
//     line participates in.
//   - everything else (txt/json/…): plain line-based ±2.
//
// All functions are pure and operate on strings — no disk, no network. The
// marker-injected copy is produced in memory; the caller never writes the
// original file.

const CONTEXT = 2;

export interface LineSpec {
  path: string;
  startLine: number;
  endLine: number;
  col: number | undefined;
}

// Parse a trailing location spec: path:N | path:N-M | path:N:C. The column
// form (path:N:C) is parsed but only the line is used for extraction (column is
// surfaced for callers that may want it). Returns null when there is no spec.
export function parseLineSpec(token: string): LineSpec | null {
  // path:N:C
  let m = token.match(/^(.+?):(\d+):(\d+)$/);
  if (m) {
    return { path: m[1], startLine: +m[2], endLine: +m[2], col: +m[3] };
  }
  // path:N-M
  m = token.match(/^(.+?):(\d+)-(\d+)$/);
  if (m) {
    return { path: m[1], startLine: +m[2], endLine: +m[3], col: undefined };
  }
  // path:N
  m = token.match(/^(.+?):(\d+)$/);
  if (m) {
    return { path: m[1], startLine: +m[2], endLine: +m[2], col: undefined };
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

const BRACE_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'go', 'rs', 'css']);

export interface ContextRange {
  text: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
}

/**
 * Extract the referenced location plus AST-aware ±2 lines of context.
 * `start`/`end` are 1-based line numbers. `ext` selects the heuristic.
 */
export function extractContextRange(source: string, start: number, end: number, ext: string): ContextRange {
  const lines = source.split('\n');
  const total = lines.length;

  let lo = clamp(start - CONTEXT, 1, total);
  let hi = clamp(end + CONTEXT, 1, total);

  if (BRACE_LANGS.has(ext)) {
    // Brace-aware: extend outward until the slice's curly braces balance, so a
    // block isn't cut mid-body. Capped so a pathological file can't pull in the
    // whole thing.
    const cap = 40;
    const balance = (a: number, b: number): number => {
      let depth = 0;
      for (let i = a - 1; i < b; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
      }
      return depth;
    };
    let guard = 0;
    while (guard++ < cap) {
      const d = balance(lo, hi);
      if (d === 0) break;
      if (d > 0 && hi < total)
        hi++; // unclosed open brace → extend down
      else if (d < 0 && lo > 1)
        lo--; // extra close brace → extend up
      else break;
    }
  } else if (ext === 'py') {
    // Indent-aware: include the contiguous block at/above the target's indent.
    const indentOf = (s: string): number =>
      s.trim() === '' ? Number.MAX_SAFE_INTEGER : s.length - s.trimStart().length;
    const baseIndent = indentOf(lines[start - 1] ?? '');
    while (lo > 1 && indentOf(lines[lo - 2]) >= baseIndent) lo--;
    while (hi < total && indentOf(lines[hi]) >= baseIndent) hi++;
  }
  // else: plain line-based ±2 (already set).

  return {
    text: lines.slice(lo - 1, hi).join('\n'),
    startLine: lo,
    endLine: hi,
  };
}

// Strip the common leading whitespace from all non-blank lines (shift-tab).
export function shiftTab(code: string): string {
  const lines = code.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const indent = l.length - l.trimStart().length;
    if (indent < min) min = indent;
  }
  if (!isFinite(min) || min === 0) return code;
  return lines.map((l) => (l.trim() === '' ? l : l.slice(min))).join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Render a snippet as a Telegram quote: <pre><code class="language-X"> with the
// body indented 2 spaces (spec §Line-spec). The body is HTML-escaped.
export function renderQuote(code: string, lang: string): string {
  const langClass = lang || 'text';
  const body = shiftTab(code)
    .split('\n')
    .map((l) => '  ' + escapeHtml(l))
    .join('\n');
  return `<pre><code class="language-${langClass}">\n${body}\n</code></pre>`;
}

// Comment delimiters per ext. CSS (and other block-only langs) need a closing
// delimiter or the marker would comment out the rest of the file.
const COMMENT_STYLE: Record<string, { open: string; close: string }> = {
  ts: { open: '//', close: '' },
  tsx: { open: '//', close: '' },
  js: { open: '//', close: '' },
  jsx: { open: '//', close: '' },
  go: { open: '//', close: '' },
  rs: { open: '//', close: '' },
  css: { open: '/*', close: ' */' },
  py: { open: '#', close: '' },
  sh: { open: '#', close: '' },
  yaml: { open: '#', close: '' },
  yml: { open: '#', close: '' },
};

// A visible marker band so the referenced range is easy to spot in the attached
// copy. ONLY applied to the in-memory copy sent to TG — never the original file.
export function injectMarkers(source: string, start: number, end: number, ext: string): string {
  const style = COMMENT_STYLE[ext] ?? { open: '//', close: '' };
  const dashes = '-'.repeat(40);
  const marker = `${style.open} line: ${dashes}${style.close}`;
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (lineNo === start) out.push(marker);
    out.push(lines[i]);
    if (lineNo === end) out.push(marker);
  }
  return out.join('\n');
}

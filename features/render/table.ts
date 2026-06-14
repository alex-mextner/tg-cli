// --- Monospace table renderer (`tg --table`) ---
//
// Telegram has NO native HTML table tag. The only way to show aligned columns
// is a padded monospace block wrapped in <pre> (Telegram renders <pre> in a
// fixed-width font). This module turns delimited rows into a box-drawn,
// column-aligned <pre> string. Adapted from the reference renderer
// (/tmp/mktable.ts): box-drawing borders, padEnd alignment, HTML-escaped cells.
//
// PURE — no I/O. The entrypoint reads stdin, calls parseTableRows + renderTable,
// and feeds the <pre> result into the normal send pipeline (so it composes with
// --tag / --title exactly like any other HTML message body).

// HTML-escape a cell so literal <, >, & in the data can never break the <pre>
// wrapper's parsing. Mirrors render/html.ts escapeHtml (kept local so the pure
// table module has no cross-feature import beyond what it needs).
export function escapeCell(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A double-width glyph (emoji, CJK) is ONE JS string unit wide to padEnd but
// renders two cells wide in a monospace font, so a row carrying one would push
// its column out of alignment. We do NOT try to width-correct (Telegram's exact
// glyph metrics are unknowable); instead we DROP the variation selectors and
// detect remaining wide glyphs so the caller can warn. This keeps columns
// aligned for the overwhelmingly-common ASCII/Cyrillic case the CTO sends.
const WIDE_GLYPH_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{1F1E6}-\u{1F1FF}\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{AC00}-\u{D7AF}]/u;

export function hasWideGlyph(s: string): boolean {
  return WIDE_GLYPH_RE.test(s);
}

export interface ParsedTable {
  rows: string[][];
  // True when any cell carried a double-width glyph that may misalign columns.
  // The caller surfaces a one-line stderr note; the table still renders.
  hasWide: boolean;
}

// Parse delimited text into a grid of cells. Each non-empty line is a row; a
// row is split on the first delimiter that appears in it, preferring a literal
// tab (TSV) then a pipe (`a | b`). Surrounding whitespace per cell is trimmed.
// Blank lines are dropped. A line with no delimiter is a single-cell row.
//
// The first row is treated by the caller as the header (renderTable draws a
// separator under row 0); this function does not special-case it.
export function parseTableRows(input: string): ParsedTable {
  const rows: string[][] = [];
  let hasWide = false;
  for (const rawLine of input.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') continue;
    // TSV wins over pipe: a tab is unambiguous, a pipe might be real content.
    const delim = line.includes('\t') ? '\t' : line.includes('|') ? '|' : null;
    const cells = (delim === null ? [line] : line.split(delim)).map((c) => c.trim());
    for (const c of cells) {
      if (hasWideGlyph(c)) hasWide = true;
    }
    rows.push(cells);
  }
  return { rows, hasWide };
}

// Render a grid of cells into a box-drawn, column-aligned monospace block. The
// first row is the header (a separator is drawn beneath it). Column widths
// auto-size to the widest cell in each column. Ragged rows are padded with
// empty trailing cells so every row spans every column. Returns the raw block
// (NOT yet wrapped in <pre> — the caller wraps + escapes via toTablePre).
export function renderTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  // Normalize ragged rows to a full-width grid.
  const grid = rows.map((r) => {
    const padded = r.slice();
    while (padded.length < cols) padded.push('');
    return padded;
  });
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths.push(Math.max(...grid.map((r) => r[c].length), 1));
  }
  const bar = (l: string, m: string, r: string): string => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const top = bar('┌', '┬', '┐');
  const sep = bar('├', '┼', '┤');
  const bot = bar('└', '┴', '┘');
  const line = (cells: string[]): string => '│ ' + cells.map((cell, c) => cell.padEnd(widths[c])).join(' │ ') + ' │';

  const out: string[] = [top, line(grid[0])];
  if (grid.length > 1) out.push(sep);
  for (let i = 1; i < grid.length; i++) out.push(line(grid[i]));
  out.push(bot);
  return out.join('\n');
}

// Full pipeline: a raw delimited input string → an HTML <pre> table body ready
// to send. Alignment runs on the RAW cells (so `&`→`&amp;` escaping can't skew
// the column math — `&amp;` is 5 visible chars but renders as one), then the
// fully-rendered block is HTML-escaped as a whole. Box-drawing glyphs
// (│ ┌ ─ …) are not HTML-special, so only real cell content is escaped. The
// result is wrapped in <pre>.
export function toTablePre(input: string): { html: string; hasWide: boolean } {
  const { rows, hasWide } = parseTableRows(input);
  return { html: `<pre>${escapeCell(renderTable(rows))}</pre>`, hasWide };
}

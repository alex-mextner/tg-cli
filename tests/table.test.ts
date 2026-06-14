import { expect, test } from 'bun:test';
import { escapeCell, hasWideGlyph, parseTableRows, renderTable, toTablePre } from '../features/render/table';

// --- parseTableRows ---

test('parses TSV rows, trims cells, drops blank lines', () => {
  const { rows } = parseTableRows('task\tstatus\nship\tdone\n\n  review  \t  wip  ');
  expect(rows).toEqual([
    ['task', 'status'],
    ['ship', 'done'],
    ['review', 'wip'],
  ]);
});

test('parses pipe-delimited rows (`a | b`)', () => {
  const { rows } = parseTableRows('task | status\nship | done');
  expect(rows).toEqual([
    ['task', 'status'],
    ['ship', 'done'],
  ]);
});

test('TSV wins over pipe when both appear in a line', () => {
  // A tab is unambiguous; a pipe inside a cell must stay content.
  const { rows } = parseTableRows('a|b\tc');
  expect(rows).toEqual([['a|b', 'c']]);
});

test('a line with no delimiter is a single-cell row', () => {
  const { rows } = parseTableRows('just one column');
  expect(rows).toEqual([['just one column']]);
});

test('strips trailing CR (CRLF input)', () => {
  const { rows } = parseTableRows('a\tb\r\nc\td\r');
  expect(rows).toEqual([
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

// --- hasWideGlyph / wide detection ---

test('hasWideGlyph detects emoji and CJK, not ASCII/Cyrillic', () => {
  expect(hasWideGlyph('done')).toBe(false);
  expect(hasWideGlyph('готово')).toBe(false); // Cyrillic is single-width
  expect(hasWideGlyph('done ✅')).toBe(true);
  expect(hasWideGlyph('完了')).toBe(true);
});

test('parseTableRows flags hasWide when a cell carries a double-width glyph', () => {
  expect(parseTableRows('a\tb').hasWide).toBe(false);
  expect(parseTableRows('a\t✅').hasWide).toBe(true);
});

// --- renderTable: alignment + borders ---

test('renders an aligned box-drawn table; columns padEnd to the widest cell', () => {
  const out = renderTable([
    ['task', 'status'],
    ['ship', 'done'],
    ['review-cli', 'wip'],
  ]);
  const lines = out.split('\n');
  // Header separator present (a sep row under row 0).
  expect(lines[0]).toBe('┌────────────┬────────┐');
  expect(lines[1]).toBe('│ task       │ status │');
  expect(lines[2]).toBe('├────────────┼────────┤');
  expect(lines[3]).toBe('│ ship       │ done   │');
  expect(lines[4]).toBe('│ review-cli │ wip    │');
  expect(lines[5]).toBe('└────────────┴────────┘');
  // Every content/border line is the same visual width → columns are aligned.
  const widths = new Set(lines.map((l) => [...l].length));
  expect(widths.size).toBe(1);
});

test('ragged rows are padded to full width', () => {
  const out = renderTable([
    ['a', 'b', 'c'],
    ['x'], // short row → padded with two empty cells
  ]);
  const lines = out.split('\n');
  const widths = new Set(lines.map((l) => [...l].length));
  expect(widths.size).toBe(1);
});

test('a single-row table has no separator line', () => {
  const out = renderTable([['only', 'header']]);
  const lines = out.split('\n');
  // top, the one row, bottom — no ├ separator.
  expect(lines.length).toBe(3);
  expect(lines.some((l) => l.startsWith('├'))).toBe(false);
});

test('empty grid renders nothing', () => {
  expect(renderTable([])).toBe('');
});

// --- escapeCell + toTablePre (HTML safety) ---

test('escapeCell escapes &, <, >', () => {
  expect(escapeCell('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
});

test('toTablePre wraps in <pre> and HTML-escapes cell content', () => {
  const { html } = toTablePre('name\tnote\nA <x>\tit & that');
  expect(html.startsWith('<pre>')).toBe(true);
  expect(html.endsWith('</pre>')).toBe(true);
  // Literal <, >, & in the data are escaped so they cannot break the wrapper.
  expect(html).toContain('A &lt;x&gt;');
  expect(html).toContain('it &amp; that');
  // Box-drawing glyphs are NOT HTML-special and stay verbatim.
  expect(html).toContain('┌');
  expect(html).toContain('│');
});

test('toTablePre alignment is computed on RAW cells (escaping does not skew columns)', () => {
  // `&` (1 char) becomes `&amp;` (5 chars); padding must be on the raw width so
  // the column still aligns visually in a monospace font.
  const { html } = toTablePre('h1\th2\na & b\tx');
  const body = html.replace(/^<pre>/, '').replace(/<\/pre>$/, '');
  const lines = body.split('\n');
  // The data row, with `&` un-escaped back, must be the same width as the border.
  const unescaped = lines.map((l) => l.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  const widths = new Set(unescaped.map((l) => [...l].length));
  expect(widths.size).toBe(1);
});

test('toTablePre surfaces hasWide for emoji cells', () => {
  expect(toTablePre('a\tb').hasWide).toBe(false);
  expect(toTablePre('a\t✅ done').hasWide).toBe(true);
});

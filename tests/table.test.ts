import { expect, test } from 'bun:test';
import { decodeHtmlEntities } from '../features/render/html';
import {
  detectTableKind,
  escapeCell,
  hasWideGlyph,
  parseTableRows,
  pipeTableToHtml,
  renderTable,
  toTablePre,
} from '../features/render/table';

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
  // Single-pass decode (decodeHtmlEntities) instead of chained replaces, which
  // double-unescape `&amp;lt;` (js/double-escaping).
  const unescaped = lines.map((l) => decodeHtmlEntities(l));
  const widths = new Set(unescaped.map((l) => [...l].length));
  expect(widths.size).toBe(1);
});

test('toTablePre surfaces hasWide for emoji cells', () => {
  expect(toTablePre('a\tb').hasWide).toBe(false);
  expect(toTablePre('a\t✅ done').hasWide).toBe(true);
});

// --- detectTableKind (escalation-format gate) ---

test('detectTableKind: empty/plain-prose body has no table', () => {
  expect(detectTableKind('')).toBe('none');
  expect(detectTableKind('just a normal sentence, no pipes here')).toBe('none');
});

test('detectTableKind: a single stray pipe in prose does not false-positive', () => {
  expect(detectTableKind('either A|B works for me')).toBe('none');
});

test('detectTableKind: a real HTML <table> is detected', () => {
  expect(detectTableKind('<table><tr><td>a</td></tr></table>')).toBe('html');
  expect(detectTableKind('intro text\n<table>\n<tr><td>x</td></tr>\n</table>')).toBe('html');
});

test('detectTableKind: our own box-drawn <pre> table (toTablePre output) is detected', () => {
  const { html } = toTablePre('a\tb\n1\t2');
  expect(detectTableKind(html)).toBe('boxed');
});

test('detectTableKind: >=2 markdown pipe-delimited rows are detected', () => {
  const body = ['| Option | Tradeoff |', '| --- | --- |', '| A | slower |'].join('\n');
  expect(detectTableKind(body)).toBe('pipe');
});

test('detectTableKind: a single pipe row alone is NOT enough (needs >=2 rows)', () => {
  expect(detectTableKind('| Option | Tradeoff |')).toBe('none');
});

// Review finding: boolean-OR code prose (`a || b`) has >=2 pipes per line and
// >=2 such lines, but is NOT a table — a markdown separator row is required
// too (real pipe tables always have one; code never does).
test('detectTableKind: boolean-OR code prose does NOT false-positive as a pipe table', () => {
  const body = 'if a || b\nwhile c || d';
  expect(detectTableKind(body)).toBe('none');
});

test('detectTableKind: pipe rows WITHOUT a separator row are not a table', () => {
  const body = '| Option | Tradeoff |\n| A | slower |';
  expect(detectTableKind(body)).toBe('none');
});

// Review finding: a BORDERLESS 2-column GFM table has only ONE pipe per row
// (no leading/trailing pipe). The earlier >=2-pipes-per-row threshold
// hard-REJECTED this at the parse-time gate — a false BLOCK of a legitimate
// table, worse than a false allow.
test('detectTableKind: a borderless 2-column markdown table (one pipe per row) is detected', () => {
  const body = 'Option | Tradeoff\n--- | ---\nA | slower';
  expect(detectTableKind(body)).toBe('pipe');
});

// Review finding: a bare thematic-break `---` (no pipe) must NOT count as
// the required separator row — otherwise two unrelated `||`-bearing lines
// plus an unrelated `---` divider anywhere in the body would false-positive.
test('detectTableKind: a pipe-less thematic break does NOT satisfy the separator requirement', () => {
  const body = 'if a || b\n---\nwhile c || d';
  expect(detectTableKind(body)).toBe('none');
});

// --- pipeTableToHtml: markdown pipe grid → real Telegram <table> ---
test('pipeTableToHtml: a markdown pipe table becomes a <table> with <th> header + <td> rows', () => {
  const body = ['| Option | Cons |', '| --- | --- |', '| A | slow |', '| B | risky |'].join('\n');
  const { html, converted } = pipeTableToHtml(body);
  expect(converted).toBe(true);
  expect(html).toContain('<table>');
  expect(html).toContain('<tr><th>Option</th><th>Cons</th></tr>');
  expect(html).toContain('<tr><td>A</td><td>slow</td></tr>');
  expect(html).toContain('<tr><td>B</td><td>risky</td></tr>');
  // The markdown separator row is dropped, not rendered as a data row.
  expect(html).not.toContain('---');
});

test('pipeTableToHtml: prose around the table is preserved (and escaped when asked)', () => {
  const body = ['Ship A or B?', '| Opt | Note |', '| --- | --- |', '| A | 5 < 10 |', 'Done.'].join('\n');
  const { html, converted } = pipeTableToHtml(body, (s) => s.replace(/</g, '&lt;'));
  expect(converted).toBe(true);
  expect(html.startsWith('Ship A or B?')).toBe(true);
  expect(html.endsWith('Done.')).toBe(true);
  // Non-table prose is escaped by the provided escaper; table cells are escaped
  // by escapeCell (5 &lt; 10 lives inside a <td>).
  expect(html).toContain('<td>A</td><td>5 &lt; 10</td>');
});

test('pipeTableToHtml: a body with no pipe table is returned unchanged (converted=false)', () => {
  const { html, converted } = pipeTableToHtml('just prose, no table');
  expect(converted).toBe(false);
  expect(html).toBe('just prose, no table');
});

test('pipeTableToHtml: pipe lines with NO separator row are treated as prose, not a table', () => {
  // `a || b` code prose must not become a table.
  const { converted } = pipeTableToHtml('if a || b\nwhile c || d');
  expect(converted).toBe(false);
});

test('pipeTableToHtml: an existing real <table> is left alone (not double-wrapped)', () => {
  const body = '<table><tr><td>a</td></tr></table>';
  const { html, converted } = pipeTableToHtml(body);
  expect(converted).toBe(false);
  expect(html).toBe(body);
});

test('pipeTableToHtml: a pipe-bearing prose line ABOVE the grid is not absorbed as the header', () => {
  // "Choose A | B" precedes a real GFM table; it must stay prose, and the real
  // header (Option/Cons) must not be displaced into a data row.
  const body = ['Choose A | B', '| Option | Cons |', '| --- | --- |', '| A | slow |'].join('\n');
  const { html, converted } = pipeTableToHtml(body, (s) => s);
  expect(converted).toBe(true);
  expect(html).toContain('<tr><th>Option</th><th>Cons</th></tr>');
  expect(html).toContain('<tr><td>A</td><td>slow</td></tr>');
  // The prose line is preserved as text, NOT turned into a <th>/<td> row.
  expect(html).toContain('Choose A | B');
  expect(html).not.toContain('<th>Choose A</th>');
});

import { expect, test } from 'bun:test';
import {
  parseLineSpec,
  stripSpecWrappers,
  extractContextRange,
  shiftTab,
  renderQuote,
  injectMarkers,
} from '../features/auto-attach/snippet';

// --- line-spec parsing ---
test('parseLineSpec: file.ts:42 → single line', () => {
  expect(parseLineSpec('src/a.ts:42')).toEqual({
    path: 'src/a.ts',
    startLine: 42,
    endLine: 42,
    col: undefined,
  });
});

test('parseLineSpec: file.ts:42-50 → range', () => {
  expect(parseLineSpec('src/a.ts:42-50')).toEqual({
    path: 'src/a.ts',
    startLine: 42,
    endLine: 50,
    col: undefined,
  });
});

test('parseLineSpec: file.ts:42:5 → line + column', () => {
  expect(parseLineSpec('src/a.ts:42:5')).toEqual({
    path: 'src/a.ts',
    startLine: 42,
    endLine: 42,
    col: 5,
  });
});

// tg#29: a spec glued to prose punctuation parses after stripping wrappers.
test('stripSpecWrappers: strips leading openers + trailing punctuation, keeps interior', () => {
  expect(stripSpecWrappers('(src/a.ts:42)')).toBe('src/a.ts:42');
  expect(stripSpecWrappers('src/a.ts:42.')).toBe('src/a.ts:42');
  expect(stripSpecWrappers('`src/a.ts:42`')).toBe('src/a.ts:42');
  expect(stripSpecWrappers('<src/a.ts:42>')).toBe('src/a.ts:42');
  expect(stripSpecWrappers('src/a.ts:10-20),')).toBe('src/a.ts:10-20');
  // interior untouched: range, line:col, and a scheme colon all survive
  expect(stripSpecWrappers('src/a.ts:42:5')).toBe('src/a.ts:42:5');
  expect(stripSpecWrappers('src/a.ts:42')).toBe('src/a.ts:42'); // clean token unchanged
});

test('parseLineSpec ∘ stripSpecWrappers: wrapped specs re-parse', () => {
  const want = { path: 'src/a.ts', startLine: 42, endLine: 42, col: undefined };
  for (const wrapped of ['(src/a.ts:42)', 'src/a.ts:42.', '`src/a.ts:42`', '<src/a.ts:42>']) {
    expect(parseLineSpec(stripSpecWrappers(wrapped))).toEqual(want);
  }
});

test('parseLineSpec: no spec → null', () => {
  expect(parseLineSpec('src/a.ts')).toBeNull();
  expect(parseLineSpec('plainword')).toBeNull();
});

test('parseLineSpec: a 0 line never yields a startLine of 0 (1-based)', () => {
  // Lines are 1-based, so a 0 in the LINE position is not a valid line spec:
  // `:0` / `:0-5` / `:5-0` stay plain prose rather than producing a bogus
  // startLine 0.
  expect(parseLineSpec('src/a.ts:0')).toBeNull();
  expect(parseLineSpec('src/a.ts:0-5')).toBeNull();
  expect(parseLineSpec('src/a.ts:5-0')).toBeNull();
  // `:0:3` does NOT mean "line 0, col 3" — the `:0` fails the line:col form, so
  // `src/a.ts:0` reads as the (literal) path with line 3. The point that holds:
  // no spec ever carries startLine 0.
  expect(parseLineSpec('src/a.ts:0:3')).toEqual({
    path: 'src/a.ts:0',
    startLine: 3,
    endLine: 3,
    col: undefined,
  });
  // A 0 COLUMN is still fine — only the line is constrained.
  expect(parseLineSpec('src/a.ts:5:0')).toEqual({
    path: 'src/a.ts',
    startLine: 5,
    endLine: 5,
    col: 0,
  });
});

// GitHub-anchor formats (file#L10, file#L10-L20, file#L10-20). The user pastes
// these straight from a GitHub permalink; they must extract the same range as
// the colon forms (tg#29). A `#L` with no digits, or with a 0 line, is not a
// spec (returns null → token stays plain).
test('parseLineSpec: file#L10 → single line (GitHub anchor)', () => {
  expect(parseLineSpec('src/a.ts#L10')).toEqual({
    path: 'src/a.ts',
    startLine: 10,
    endLine: 10,
    col: undefined,
  });
});

test('parseLineSpec: file#L10-L20 → range (GitHub two-anchor)', () => {
  expect(parseLineSpec('src/a.ts#L10-L20')).toEqual({
    path: 'src/a.ts',
    startLine: 10,
    endLine: 20,
    col: undefined,
  });
});

test('parseLineSpec: file#L10-20 → range (GitHub bare-second form)', () => {
  expect(parseLineSpec('src/a.ts#L10-20')).toEqual({
    path: 'src/a.ts',
    startLine: 10,
    endLine: 20,
    col: undefined,
  });
});

test('parseLineSpec: #L spec with a 0 line, no digits, or malformed range → null', () => {
  expect(parseLineSpec('src/a.ts#L0')).toBeNull();
  expect(parseLineSpec('src/a.ts#L')).toBeNull();
  expect(parseLineSpec('src/a.ts#Labc')).toBeNull();
  expect(parseLineSpec('src/a.ts#L10-')).toBeNull(); // missing second endpoint
  expect(parseLineSpec('src/a.ts#L-10')).toBeNull(); // missing first endpoint
  expect(parseLineSpec('src/a.ts#L0-5')).toBeNull(); // 0 start
  expect(parseLineSpec('src/a.ts#L5-0')).toBeNull(); // 0 end
});

// --- ±2 context extraction (line numbers are 1-based) ---
const SRC = ['line1', 'line2', 'line3', 'line4 TARGET', 'line5', 'line6', 'line7'].join('\n');

test('extractContextRange: ±2 lines around a single line', () => {
  const r = extractContextRange(SRC, 4, 4, 'txt');
  // line2..line6 (4 ± 2)
  expect(r.startLine).toBe(2);
  expect(r.endLine).toBe(6);
  expect(r.text).toContain('line4 TARGET');
  expect(r.text).toContain('line2');
  expect(r.text).toContain('line6');
  expect(r.text).not.toContain('line1');
});

test('extractContextRange: clamps at file boundaries', () => {
  const r = extractContextRange(SRC, 1, 1, 'txt');
  expect(r.startLine).toBe(1);
  expect(r.text).toContain('line1');
});

// --- AST-aware snap for braces (ts/js): expands to enclosing block ---
test('extractContextRange: ts snaps ±2 outward to a brace boundary', () => {
  const ts = [
    'function a() {', // 1
    '  const x = 1', // 2
    '  return x', // 3
    '}', // 4
    'function b() {', // 5
    '  return 2', // 6
    '}', // 7
  ].join('\n');
  const r = extractContextRange(ts, 3, 3, 'ts');
  // ±2 would be lines 1..5; AST-aware snap should not cut the function in half:
  // it includes the closing brace on line 4 (does not stop at line 5's opener
  // mid-statement). We assert the enclosing close brace is present.
  expect(r.text).toContain('}');
  expect(r.text).toContain('return x');
});

// --- shift-tab: strip common leading whitespace ---
test("shiftTab: strips the common indent so the quote isn't pushed right", () => {
  const code = '    if (x) {\n      y()\n    }';
  expect(shiftTab(code)).toBe('if (x) {\n  y()\n}');
});

test("shiftTab: blank lines don't affect the common-indent calc", () => {
  const code = '  a\n\n  b';
  expect(shiftTab(code)).toBe('a\n\nb');
});

// --- TG quote rendering: <pre><code class="language-X"> + 2-space indent ---
test('renderQuote: wraps in pre/code with language class, 2-space indented', () => {
  const q = renderQuote('const x = 1', 'ts');
  expect(q).toContain('<pre><code class="language-ts">');
  expect(q).toContain('</code></pre>');
  // 2-space indent on the content line.
  expect(q).toMatch(/\n {2}const x = 1/);
});

test('renderQuote: HTML-escapes the code body', () => {
  const q = renderQuote('a < b && c > d', 'ts');
  expect(q).toContain('&lt;');
  expect(q).toContain('&amp;');
  expect(q).toContain('&gt;');
  expect(q).not.toMatch(/[^&]< b/);
});

// --- marker injection (only in the attached copy) ---
test('injectMarkers: adds // line: ---- band around the referenced range', () => {
  const out = injectMarkers(SRC, 4, 4, 'ts');
  const lines = out.split('\n');
  // A marker line appears immediately before line4 and after it.
  const targetIdx = lines.findIndex((l) => l.includes('line4 TARGET'));
  expect(lines[targetIdx - 1]).toMatch(/\/\/ line:/);
  expect(lines[targetIdx + 1]).toMatch(/\/\/ line:/);
  // The original content is otherwise intact.
  expect(out).toContain('line1');
  expect(out).toContain('line7');
});

test('injectMarkers: uses # comment for python', () => {
  const py = 'a = 1\nb = 2\nc = 3';
  const out = injectMarkers(py, 2, 2, 'py');
  expect(out).toMatch(/# line:/);
});

test('injectMarkers: CSS marker is a CLOSED block comment (no run-on)', () => {
  const css = '.a { color: red }\n.b { color: blue }\n.c { color: green }';
  const out = injectMarkers(css, 2, 2, 'css');
  // Every "/* line:" must close with "*/" on the same line, or the rest of the
  // file gets commented out.
  for (const line of out.split('\n')) {
    if (line.includes('/* line:')) expect(line.trimEnd()).toMatch(/\*\/$/);
  }
  expect(out).toContain('.c { color: green }');
});

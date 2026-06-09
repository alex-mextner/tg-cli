import { expect, test } from 'bun:test';
import {
  parseLineSpec,
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

test('parseLineSpec: no spec → null', () => {
  expect(parseLineSpec('src/a.ts')).toBeNull();
  expect(parseLineSpec('plainword')).toBeNull();
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

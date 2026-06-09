import { expect, test } from 'bun:test';
import {
  stripDuplicatedFileContent,
  extractLargeCodeBlocks,
  inferFragmentName,
  detectLanguage,
} from '../features/auto-attach/extract';

// --- R2: full file content duplicated verbatim in text → strip it ---
test("R2: strips a file's full content block when pasted verbatim, keeps the rest", () => {
  const content = 'line one\nline two\nline three';
  const text = `Here is the file:\n${content}\nThat was it.`;
  const out = stripDuplicatedFileContent(text, [{ path: '/x.ts', content }]);
  expect(out).not.toContain('line two');
  expect(out).toContain('Here is the file:');
  expect(out).toContain('That was it.');
});

test('R2: leaves text untouched when content is only partially present (not full dup)', () => {
  const content = 'alpha\nbeta\ngamma\ndelta';
  const text = 'I only mention alpha and beta here.'; // partial, not the full block
  const out = stripDuplicatedFileContent(text, [{ path: '/x.ts', content }]);
  expect(out).toBe(text);
});

test('R2: trailing-newline differences still match (normalized)', () => {
  const content = 'a\nb\nc\n';
  const text = `before\na\nb\nc\nafter`;
  const out = stripDuplicatedFileContent(text, [{ path: '/x.ts', content }]);
  expect(out).not.toMatch(/^a$/m);
  expect(out).toContain('before');
  expect(out).toContain('after');
});

// --- R3/R4: fenced code blocks classified by size ---
test('R3: a small fenced block (<=1024) is left inline (not extracted)', () => {
  const code = '```ts\nconst x = 1\n```';
  const blocks = extractLargeCodeBlocks(`see\n${code}\nend`);
  expect(blocks).toEqual([]);
});

test('R4: a large fenced block (>1024) is extracted with its language + content', () => {
  const big = 'x = 1\n'.repeat(300); // > 1024 chars
  const code = '```python\n' + big + '```';
  const text = `Here:\n${code}\nbye`;
  const blocks = extractLargeCodeBlocks(text);
  expect(blocks.length).toBe(1);
  expect(blocks[0].lang).toBe('python');
  expect(blocks[0].content).toContain('x = 1');
  // The block carries the exact span so the normalizer can remove it from text.
  expect(text.slice(blocks[0].start, blocks[0].end)).toBe(code);
});

// --- filename inference (spec §C) ---
test("inferFragmentName: preceding 'sentence:' becomes the filename base", () => {
  const name = inferFragmentName('Here is the auth helper:', 'ts');
  expect(name).toMatch(/\.ts$/);
  expect(name.toLowerCase()).toContain('auth');
});

test('inferFragmentName: falls back to a generic fragment name with detected ext', () => {
  const name = inferFragmentName('', 'py');
  expect(name).toMatch(/\.py$/);
});

// --- language → extension detection ---
test('detectLanguage maps fence langs and content heuristics to extensions', () => {
  expect(detectLanguage('ts', '')).toBe('ts');
  expect(detectLanguage('typescript', '')).toBe('ts');
  expect(detectLanguage('python', '')).toBe('py');
  expect(detectLanguage('', 'def foo():\n    return 1')).toBe('py');
  expect(detectLanguage('', '{\n  "a": 1\n}')).toBe('json');
  expect(detectLanguage('', 'just some prose')).toBe('txt');
});

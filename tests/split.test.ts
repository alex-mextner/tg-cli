import { expect, test } from 'bun:test';
import { splitMessage } from '../features/auto-attach/split';

const LIMIT = 4096;

test('short text is returned as a single chunk', () => {
  expect(splitMessage('hello', LIMIT)).toEqual(['hello']);
});

test('empty text returns empty array', () => {
  expect(splitMessage('', LIMIT)).toEqual([]);
});

test('splits on paragraph/newline boundaries, each chunk <= limit', () => {
  const para = 'x'.repeat(500);
  const text = Array.from({ length: 20 }, () => para).join('\n\n'); // ~10k chars
  const chunks = splitMessage(text, LIMIT);
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
  // Rejoining the visible text content is preserved (no chars dropped).
  expect(chunks.join('\n\n').replace(/\n+/g, '')).toBe(text.replace(/\n+/g, ''));
});

test('a single oversize line with no newline is hard-split at the limit', () => {
  const text = 'a'.repeat(LIMIT * 2 + 50);
  const chunks = splitMessage(text, LIMIT);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
  expect(chunks.join('')).toBe(text);
});

test('never splits mid-multibyte (emoji stay intact)', () => {
  // Each 🎉 is 2 UTF-16 code units; build a string longer than a small limit.
  const text = '🎉'.repeat(50);
  const chunks = splitMessage(text, 10);
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(10);
    // No lone surrogate at either edge.
    expect(/[\uD800-\uDBFF]$/.test(c)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(c)).toBe(false);
  }
  expect(chunks.join('')).toBe(text);
});

test('HTML: open tag spanning a boundary is closed and reopened per chunk', () => {
  const inner = 'y'.repeat(LIMIT);
  const text = `<b>${inner}</b>`;
  const chunks = splitMessage(text, LIMIT);
  expect(chunks.length).toBeGreaterThan(1);
  // Every chunk is balanced AND within the limit (closing/reopening tags must
  // not push a chunk over — regression for the budget-margin bug).
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(LIMIT);
    const opens = (c.match(/<b>/g) || []).length;
    const closes = (c.match(/<\/b>/g) || []).length;
    expect(opens).toBe(closes);
  }
});

test('plain mode does not treat <...> as tags (no balancing)', () => {
  const text = 'a<b>c'.repeat(2000); // > 4096, contains pseudo-tags
  const chunks = splitMessage(text, LIMIT, 'plain');
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(LIMIT);
  // No injected closing tags: rejoining yields the exact original.
  expect(chunks.join('')).toBe(text);
});

test('HTML: never splits inside a tag', () => {
  // A long run of text then a tag positioned so a naive cut lands mid-tag.
  const text = 'z'.repeat(LIMIT - 3) + '<code>abc</code>';
  const chunks = splitMessage(text, LIMIT);
  for (const c of chunks) {
    // No chunk ends in the middle of a tag (`<` without a closing `>`).
    const lastOpen = c.lastIndexOf('<');
    const lastClose = c.lastIndexOf('>');
    if (lastOpen !== -1) expect(lastClose).toBeGreaterThan(lastOpen);
  }
});

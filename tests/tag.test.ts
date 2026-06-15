import { expect, test } from 'bun:test';
import { resolveTag, CANONICAL_TAGS } from '../features/render/tag';

// --- Canonical English tags resolve to their fallback badge + canonical word ---
// cellDots = [colored cell0, neutral ▫️ for cells 1..n-1] — so a push
// notification shows ONE colored dot identifying the tag + quiet neutrals.
test('resolveTag: each canonical English tag resolves to its unicode fallback + dot + per-cell dots', () => {
  expect(resolveTag('ANSWER')).toEqual({
    fallback: '🔵 ANSWER',
    dot: '🔵',
    cellDots: ['🔵', '▫️', '▫️'],
    word: 'ANSWER',
    known: true,
  });
  expect(resolveTag('DECISION')).toEqual({
    fallback: '🟠 DECISION',
    dot: '🟠',
    cellDots: ['🟠', '▫️', '▫️'],
    word: 'DECISION',
    known: true,
  });
  expect(resolveTag('PROBLEM')).toEqual({
    fallback: '🔴 PROBLEM',
    dot: '🔴',
    cellDots: ['🔴', '▫️', '▫️'],
    word: 'PROBLEM',
    known: true,
  });
  expect(resolveTag('REPORT')).toEqual({
    fallback: '🟢 REPORT',
    dot: '🟢',
    cellDots: ['🟢', '▫️', '▫️'],
    word: 'REPORT',
    known: true,
  });
});

// --- Case-insensitive English input ---
test('resolveTag is case-insensitive for English input', () => {
  expect(resolveTag('answer').word).toBe('ANSWER');
  expect(resolveTag('answer').known).toBe(true);
  expect(resolveTag('Decision').word).toBe('DECISION');
  expect(resolveTag('  report  ').word).toBe('REPORT'); // trims surrounding space
});

// --- Russian aliases map to the English canonicals ---
test('resolveTag maps Russian aliases to the English canonicals', () => {
  expect(resolveTag('ОТВЕТ')).toEqual({
    fallback: '🔵 ANSWER',
    dot: '🔵',
    cellDots: ['🔵', '▫️', '▫️'],
    word: 'ANSWER',
    known: true,
  });
  expect(resolveTag('РЕШЕНИЕ')).toEqual({
    fallback: '🟠 DECISION',
    dot: '🟠',
    cellDots: ['🟠', '▫️', '▫️'],
    word: 'DECISION',
    known: true,
  });
  expect(resolveTag('ПРОБЛЕМА')).toEqual({
    fallback: '🔴 PROBLEM',
    dot: '🔴',
    cellDots: ['🔴', '▫️', '▫️'],
    word: 'PROBLEM',
    known: true,
  });
  expect(resolveTag('ОТЧЁТ')).toEqual({
    fallback: '🟢 REPORT',
    dot: '🟢',
    cellDots: ['🟢', '▫️', '▫️'],
    word: 'REPORT',
    known: true,
  });
});

test('resolveTag: Russian aliases are case-insensitive too', () => {
  expect(resolveTag('ответ').word).toBe('ANSWER');
  expect(resolveTag('Решение').word).toBe('DECISION');
});

// --- The Ё→Е spelling of ОТЧЁТ is tolerated (agents type both) ---
test('resolveTag tolerates the ОТЧЕТ (Е, no Ё) spelling', () => {
  expect(resolveTag('ОТЧЕТ')).toEqual({
    fallback: '🟢 REPORT',
    dot: '🟢',
    cellDots: ['🟢', '▫️', '▫️'],
    word: 'REPORT',
    known: true,
  });
  expect(resolveTag('отчет').word).toBe('REPORT');
});

// --- Unknown tag soft-renders (no hard fail) ---
test('resolveTag: an unknown tag is NOT known, has no fallback/dot/cellDots, word is uppercased', () => {
  expect(resolveTag('wat')).toEqual({ fallback: '', dot: '', cellDots: [], word: 'WAT', known: false });
  expect(resolveTag('FIXME')).toEqual({ fallback: '', dot: '', cellDots: [], word: 'FIXME', known: false });
});

// --- The canonical-tag list is the single source of truth ---
test('CANONICAL_TAGS lists the four English canonicals', () => {
  expect([...CANONICAL_TAGS]).toEqual(['ANSWER', 'DECISION', 'PROBLEM', 'REPORT']);
});

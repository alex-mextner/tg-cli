import { expect, test } from 'bun:test';
import { resolveTag, TAG_EMOJI } from '../features/render/tag';

// --- Canonical Russian tags resolve to their badge + canonical word ---
test('resolveTag: each canonical Russian tag resolves to its emoji badge', () => {
  expect(resolveTag('ОТВЕТ')).toEqual({ emoji: '🔵 💬', word: 'ОТВЕТ', known: true });
  expect(resolveTag('РЕШЕНИЕ')).toEqual({ emoji: '🟠 ⚖️', word: 'РЕШЕНИЕ', known: true });
  expect(resolveTag('ПРОБЛЕМА')).toEqual({ emoji: '🔴 🚨', word: 'ПРОБЛЕМА', known: true });
  expect(resolveTag('ОТЧЁТ')).toEqual({ emoji: '🟢 📋', word: 'ОТЧЁТ', known: true });
});

// --- Case-insensitive ---
test('resolveTag is case-insensitive for Russian input', () => {
  expect(resolveTag('ответ').word).toBe('ОТВЕТ');
  expect(resolveTag('ответ').known).toBe(true);
  expect(resolveTag('Решение').word).toBe('РЕШЕНИЕ');
});

// --- English aliases map to the Russian canonicals ---
test('resolveTag maps English aliases to the Russian canonicals', () => {
  expect(resolveTag('ANSWER')).toEqual({ emoji: '🔵 💬', word: 'ОТВЕТ', known: true });
  expect(resolveTag('DECISION')).toEqual({ emoji: '🟠 ⚖️', word: 'РЕШЕНИЕ', known: true });
  expect(resolveTag('PROBLEM')).toEqual({ emoji: '🔴 🚨', word: 'ПРОБЛЕМА', known: true });
  expect(resolveTag('REPORT')).toEqual({ emoji: '🟢 📋', word: 'ОТЧЁТ', known: true });
});

test('resolveTag: English aliases are case-insensitive too', () => {
  expect(resolveTag('answer').word).toBe('ОТВЕТ');
  expect(resolveTag('Decision').word).toBe('РЕШЕНИЕ');
  expect(resolveTag('  report  ').word).toBe('ОТЧЁТ'); // trims surrounding space
});

// --- The Ё→Е spelling of ОТЧЁТ is tolerated (agents type both) ---
test('resolveTag tolerates the ОТЧЕТ (Е, no Ё) spelling', () => {
  expect(resolveTag('ОТЧЕТ')).toEqual({ emoji: '🟢 📋', word: 'ОТЧЁТ', known: true });
  expect(resolveTag('отчет').word).toBe('ОТЧЁТ');
});

// --- Unknown tag soft-renders (no hard fail) ---
test('resolveTag: an unknown tag is NOT known, has no emoji, word is uppercased', () => {
  expect(resolveTag('wat')).toEqual({ emoji: '', word: 'WAT', known: false });
  expect(resolveTag('FIXME')).toEqual({ emoji: '', word: 'FIXME', known: false });
});

// --- The emoji constant is the single source of truth and editable ---
test('TAG_EMOJI exposes the default mapping (one editable constant)', () => {
  expect(TAG_EMOJI).toEqual({
    ОТВЕТ: '🔵 💬',
    РЕШЕНИЕ: '🟠 ⚖️',
    ПРОБЛЕМА: '🔴 🚨',
    ОТЧЁТ: '🟢 📋',
  });
});

import { expect, test } from 'bun:test';
import {
  toSansBold,
  toBoldItalic,
  styleWindowName,
  styleTaskTitle,
} from '../features/prefix-style/style';

// --- toSansBold ---

test('sans-bold: maps ASCII letters and digits to the math block', () => {
  expect(toSansBold('A')).toBe('\u{1D5D4}');
  expect(toSansBold('a')).toBe('\u{1D5EE}');
  expect(toSansBold('0')).toBe('\u{1D7EC}');
  expect(toSansBold('9')).toBe('\u{1D7F5}');
});

test('sans-bold: leaves hyphen/underscore/space verbatim', () => {
  const out = toSansBold('api-bot_2 x')!;
  expect(out).toContain('-');
  expect(out).toContain('_');
  expect(out).toContain(' ');
  // every ASCII letter was lifted out of the Basic Latin range
  expect(/[a-zA-Z]/.test(out)).toBe(false);
});

test('sans-bold: a Cyrillic letter forces null (caller falls back)', () => {
  expect(toSansBold('фикс')).toBeNull();
  expect(toSansBold('api-бот')).toBeNull();
});

// --- toBoldItalic ---

test('bold-italic: maps letters, leaves digits verbatim (block has no digits)', () => {
  const out = toBoldItalic('Fix v2')!;
  expect(out).toContain('2'); // digit stays plain
  expect(out).toContain(' ');
  expect(/[a-zA-Z]/.test(out)).toBe(false);
  expect(out.startsWith('\u{1D46D}')).toBe(true); // 'F' → 𝑭
});

test('bold-italic: Cyrillic forces null', () => {
  expect(toBoldItalic('Починить')).toBeNull();
});

// --- styleWindowName ---

test('window: Latin name → sans-bold unicode, no tag', () => {
  const t = styleWindowName('api-bot');
  expect(t.tag).toBe(false);
  expect(t.plain).toBe(toSansBold('api-bot'));
  expect(t.html).toBe(toSansBold('api-bot')); // no &<> to escape
});

test('window: Cyrillic name → <b> fallback, tag flagged, html-escaped', () => {
  const t = styleWindowName('фикс-бот');
  expect(t.tag).toBe(true);
  expect(t.html).toBe('<b>фикс-бот</b>');
  expect(t.plain).toBe('фикс-бот');
});

test('window: ampersand in a Latin name is escaped in html, raw in plain', () => {
  const t = styleWindowName('a&b');
  expect(t.tag).toBe(false);
  expect(t.html).toContain('&amp;');
  expect(t.plain).toContain('&');
});

// --- styleTaskTitle ---

test('title: Latin → bold-italic unicode (escaped)', () => {
  const out = styleTaskTitle('Fix autolink');
  expect(out).toBe(toBoldItalic('Fix autolink'));
  expect(/[a-zA-Z]/.test(out)).toBe(false);
});

test('title: Latin with markup chars stays escaped', () => {
  // '<' has no bold-italic glyph → left verbatim by the mapper, then escaped.
  expect(styleTaskTitle('a<b')).toContain('&lt;');
});

test('title: Cyrillic → <i> fallback, escaped inside', () => {
  expect(styleTaskTitle('Починить & готово')).toBe('<i>Починить &amp; готово</i>');
});

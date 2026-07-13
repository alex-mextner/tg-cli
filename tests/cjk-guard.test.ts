import { expect, test } from 'bun:test';
import { findStrayCjk, formatStrayCjkError } from '../features/cli/cjk-guard';

// --- findStrayCjk: the detection heuristic ---
// Stray = an isolated CJK codepoint stuck INTO otherwise Latin/Cyrillic text
// (an LLM emitting a lone ideograph mid-word). A genuinely CJK message passes.

test('flags a CJK char stuck mid-word after Cyrillic ("ка<CJK>eat")', () => {
  const finding = findStrayCjk('ка日eat'); // 日 between "ка" and "eat"
  expect(finding).not.toBeNull();
  expect(finding!.chars[0].char).toBe('日');
  expect(finding!.chars[0].codepoint).toBe(0x65e5);
});

test('flags a CJK char stuck before Cyrillic ("<CJK>ляет")', () => {
  const finding = findStrayCjk('注ляет'); // 注 then "ляет"
  expect(finding).not.toBeNull();
  expect(finding!.chars[0].char).toBe('注');
});

test('flags a stray Katakana / Hangul embedded in a Latin word', () => {
  expect(findStrayCjk('fooトbar')).not.toBeNull(); // ト
  expect(findStrayCjk('foo한bar')).not.toBeNull(); // 한
});

test('a normal English message passes', () => {
  expect(findStrayCjk('Deploy finished, all green. Ready to ship.')).toBeNull();
});

test('a normal Russian message passes', () => {
  expect(findStrayCjk('Задача выполнена, тесты зелёные, готово к вливанию.')).toBeNull();
});

test('a message with emoji passes (emoji are not CJK)', () => {
  expect(findStrayCjk('All done ✅ shipping now 🚀')).toBeNull();
});

test('accented Latin passes (not CJK)', () => {
  expect(findStrayCjk('Café déployé, résumé attaché.')).toBeNull();
});

test('a genuinely all-Japanese message passes (dominant script is CJK)', () => {
  expect(findStrayCjk('これは日本語のメッセージです。全て日本語で書いています。')).toBeNull();
});

test('a mostly-CJK message with a bit of Latin passes ("APIを実装しました")', () => {
  expect(findStrayCjk('APIを実装しました。テストも全て通っています。')).toBeNull();
});

test('a space-delimited CJK quote inside English passes', () => {
  // The kanji sits between spaces — not stuck into a word.
  expect(findStrayCjk('The word 日本語 means Japanese.')).toBeNull();
});

test('a multi-char CJK run glued to a Latin word passes (bilingual, not a lone stray)', () => {
  // A real CJK word abutting Latin — NOT the lone-ideograph bug.
  expect(findStrayCjk('Deploy到生产')).toBeNull();
  expect(findStrayCjk('3D打印')).toBeNull();
  expect(findStrayCjk('Word文書 updated')).toBeNull();
});

test('a lone CJK SUFFIX/particle glued to a Latin token passes (letter does not follow)', () => {
  // The bug shape is a letter IMMEDIATELY AFTER the ideograph. A CJK that ENDS a
  // token — Korean particle or CJK suffix — is legit bilingual text, not garble.
  expect(findStrayCjk('React를 배포')).toBeNull(); // Korean particle, space after
  expect(findStrayCjk('APIを 更新')).toBeNull(); // Japanese particle, space after
  expect(findStrayCjk('iOS版')).toBeNull(); // CJK suffix at end of string
  expect(findStrayCjk('deploy日 done')).toBeNull(); // lone CJK ending a token
});

test('a lone CJK with a letter immediately AFTER it is flagged even when a space precedes', () => {
  // Letter-follows is the trigger regardless of the left side.
  const finding = findStrayCjk('done 日eat');
  expect(finding).not.toBeNull();
  expect(finding!.chars[0].char).toBe('日');
});

test('a lone CJK immediately BEFORE a Latin token is flagged (left-abutting, letter follows)', () => {
  // Symmetric to the suffix case: `난React` (Korean glued to Latin, no space) has
  // a letter following the lone Hangul → flagged. Pinned as intentional; Korean
  // normally inserts a space (`React를 배포`), so real-world risk is low.
  const finding = findStrayCjk('난React');
  expect(finding).not.toBeNull();
  expect(finding!.chars[0].char).toBe('난');
});

test('a stray CJK inside quoted/inline-code content is STILL flagged (no code exemption)', () => {
  // Known limitation: the guard does not parse Markdown, so a quoted garble is
  // treated like a real one. `--no-feature cjk-guard` is the escape.
  expect(findStrayCjk('The token `ка日eat` was garbled')).not.toBeNull();
});

test('a heavily-CJK garble that crosses the dominance line is treated as CJK (accepted recall gap)', () => {
  // 4 kana / 4 latin = 0.5 → dominant → detection short-circuits. Pinned so the
  // tradeoff is intentional, not an accident.
  expect(findStrayCjk('aあbいcうdえ')).toBeNull();
});

test('a SHORT garble below the absolute CJK floor is scanned, not excused as dominant', () => {
  // `日a` is 50% CJK but only ONE ideograph — below the absolute floor, so it is
  // scanned and flagged (日 with a letter following). This is the exact short
  // garble the guard targets.
  expect(findStrayCjk('日a')).not.toBeNull();
  expect(findStrayCjk('1日a')).not.toBeNull();
});

test('a genuine multi-ideograph CJK message (>= the floor, >= 50%) still passes', () => {
  expect(findStrayCjk('日本語a')).toBeNull(); // 3 CJK / 1 latin → dominant
});

test('an above-BMP (supplementary-plane) Han ideograph is counted by codepoint', () => {
  const extB = String.fromCodePoint(0x20000); // one codepoint, two UTF-16 units
  const finding = findStrayCjk(`ab${extB}cd`);
  expect(finding).not.toBeNull();
  expect(finding!.chars[0].codepoint).toBe(0x20000);
  expect(finding!.chars[0].index).toBe(2);
  // The 5-hex-digit codepoint renders without truncation by padStart.
  expect(formatStrayCjkError(finding!)).toContain('U+20000');
});

test('an above-BMP emoji does not shift the reported CJK index', () => {
  const finding = findStrayCjk('a日b😀e'); // 😀 is U+1F600, one codepoint element
  expect(finding).not.toBeNull();
  expect(finding!.chars[0].index).toBe(1); // 日 still at codepoint-index 1
});

test('empty / whitespace text passes', () => {
  expect(findStrayCjk('')).toBeNull();
  expect(findStrayCjk('   \n  ')).toBeNull();
});

test('a CJK char whose neighbours are digits or punctuation, not letters, passes', () => {
  // "against a LETTER" is the trigger — a lone kanji flanked by digits or
  // brackets (a quote-like reference) is not the mid-word bug.
  expect(findStrayCjk('12日34')).toBeNull();
  expect(findStrayCjk('see (日) here')).toBeNull();
  expect(findStrayCjk('ref: 日, next')).toBeNull();
});

test('reports every stray char with its 0-based codepoint index', () => {
  const finding = findStrayCjk('ка日eat and mo注re');
  expect(finding).not.toBeNull();
  expect(finding!.chars.length).toBe(2);
  expect(finding!.chars.map((c) => c.char)).toEqual(['日', '注']);
  expect(finding!.chars[0].index).toBe(2); // ка日 → 日 is codepoint 2
});

test('the error message names the offending char and its codepoint', () => {
  const finding = findStrayCjk('ка日eat')!;
  const msg = formatStrayCjkError(finding);
  expect(msg).toContain('日');
  expect(msg).toContain('U+65E5');
  expect(msg.toLowerCase()).toContain('cjk');
  expect(msg).toContain('--no-feature cjk-guard');
});


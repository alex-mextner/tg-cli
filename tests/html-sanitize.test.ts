import { expect, test } from 'bun:test';
import { decodeHtmlEntities, stripHtmlTags } from '../features/render/html';
import { escapeRegExp } from '../features/util/regex';
import { isRichHtml } from '../features/render/rich';

// These pin the CodeQL findings the shared helpers were extracted to close:
// js/incomplete-multi-character-sanitization (stripHtmlTags), js/double-escaping
// (decodeHtmlEntities), and js/incomplete-sanitization (escapeRegExp). Each test
// is the exact failure mode CodeQL flagged for the old inline code.

// --- stripHtmlTags ---

test('stripHtmlTags removes well-formed tags', () => {
  expect(stripHtmlTags('<b>hi</b> there')).toBe('hi there');
  expect(stripHtmlTags('<a href="x">link</a>')).toBe('link');
});

test('stripHtmlTags removes a trailing UNTERMINATED tag (no closing >)', () => {
  // The js/incomplete-multi-character-sanitization case: a naive /<[^>]+>/g
  // leaves a dangling `<script` behind. The trailing tag-like branch removes it.
  expect(stripHtmlTags('hello <script')).toBe('hello ');
  expect(stripHtmlTags('a<b>c</b><i')).toBe('ac');
  expect(stripHtmlTags('end </div')).toBe('end ');
  expect(stripHtmlTags('<incomplete')).toBe('');
});

test('stripHtmlTags preserves a lone literal < that is not tag-like', () => {
  expect(stripHtmlTags('plain text')).toBe('plain text');
  // A trailing `<` followed by a space (or digit) is ordinary text, not a
  // cut-off tag, so it is NOT greedily consumed to end-of-string.
  expect(stripHtmlTags('keep < this')).toBe('keep < this');
  expect(stripHtmlTags('a < b')).toBe('a < b');
  // A balanced `<…>` still reads as a tag and is stripped (matches the prior
  // /<[^>]+>/g behavior); only the dangling-trailing case changed.
  expect(stripHtmlTags('a < b and c > d')).toBe('a  d');
});

// --- decodeHtmlEntities ---

test('decodeHtmlEntities decodes the documented entity set', () => {
  expect(decodeHtmlEntities('a &amp; b &lt; c &gt; d')).toBe('a & b < c > d');
  expect(decodeHtmlEntities('say &quot;hi&quot; &#39;yo&#39;')).toBe('say "hi" \'yo\'');
});

test('decodeHtmlEntities does NOT double-unescape &amp;lt;', () => {
  // js/double-escaping: chained `&amp;`→`&` then `&lt;`→`<` turns `&amp;lt;`
  // into `<`. A single pass must yield the literal `&lt;`.
  expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
});

test('decodeHtmlEntities leaves unknown entities verbatim', () => {
  expect(decodeHtmlEntities('&copy; &unknown; &amp;')).toBe('&copy; &unknown; &');
});

// --- escapeRegExp ---

test('escapeRegExp escapes the full ECMAScript metacharacter set', () => {
  const src = '.*+?^${}()|[]\\-';
  // Embed the escaped source between sentinels and anchor with ^…$, so an
  // UNescaped anchor (`^`/`$`) or any metachar that changed the pattern's
  // meaning would fail to match the literal sentinel-wrapped string. A bare
  // `re.test(src)` would pass even for a broken impl (anchors match empty).
  const re = new RegExp('^X' + escapeRegExp(src) + 'X$');
  expect(re.test('X' + src + 'X')).toBe(true);
  // And the exact-match guard: the whole input is consumed, not a substring.
  const m = ('X' + src + 'X').match(new RegExp(escapeRegExp(src)));
  expect(m?.[0]).toBe(src);
});

test('escapeRegExp neutralizes a backslash (the js/incomplete-sanitization gap)', () => {
  // A hyphen-only escaper left `\` raw, so a token containing `\d` would change
  // the pattern. A full escaper treats it literally.
  const re = new RegExp(escapeRegExp('a\\d'));
  expect(re.test('a\\d')).toBe(true);
  expect(re.test('a5')).toBe(false);
});

test('escapeRegExp keeps hyphenated rich tag names literal in an alternation', () => {
  const re = new RegExp('(?:' + ['tg-math-block', 'tg-math'].map(escapeRegExp).join('|') + ')');
  expect(re.test('tg-math-block')).toBe(true);
  expect(re.test('tg-math')).toBe(true);
});

test('RICH_TAG_RE (built with escapeRegExp) still detects hyphenated rich tags', () => {
  // Pins the real regex in rich.ts, not just escapeRegExp in isolation — so a
  // future edit to the escape/sort/lookahead composition fails a test here.
  expect(isRichHtml('a <tg-math>E=mc^2</tg-math> b')).toBe(true);
  expect(isRichHtml('<tg-math-block>x</tg-math-block>')).toBe(true);
  expect(isRichHtml('<table><tr><td>x</td></tr></table>')).toBe(true);
  // A basic-only body must NOT be misdetected as rich.
  expect(isRichHtml('<b>bold</b> and <a href="https://x">link</a>')).toBe(false);
});

test('escapeRegExp escapes `-` so it is a literal, not a range, inside a char class', () => {
  // `[a-c]` would match `b`; with `-` escaped, the class is the three literal
  // chars `a`, `-`, `c` and must NOT match `b`.
  const re = new RegExp('^[' + escapeRegExp('a-c') + ']$');
  expect(re.test('a')).toBe(true);
  expect(re.test('-')).toBe(true);
  expect(re.test('c')).toBe(true);
  expect(re.test('b')).toBe(false);
});

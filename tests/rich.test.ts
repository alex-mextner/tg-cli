import { expect, test } from 'bun:test';
import { isRichHtml, RICH_LIMITS, validateRichHtml } from '../features/render/rich';

// --- isRichHtml: rich-only tags trigger the rich route ----------------------

test('a <table> triggers the rich route', () => {
  expect(isRichHtml('<table><tr><td>a</td></tr></table>')).toBe(true);
});

test('headings h1..h6 trigger the rich route', () => {
  for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    expect(isRichHtml(`<${h}>Title</${h}>`)).toBe(true);
  }
});

test('lists ul/ol/li trigger the rich route', () => {
  expect(isRichHtml('<ul><li>a</li></ul>')).toBe(true);
  expect(isRichHtml('<ol><li>a</li></ol>')).toBe(true);
});

test('a divider <hr> and <p> trigger the rich route', () => {
  expect(isRichHtml('<hr/>')).toBe(true);
  expect(isRichHtml('<p>para</p>')).toBe(true);
});

test('formula tags (tg-math, tg-math-block) trigger the rich route', () => {
  expect(isRichHtml('<tg-math>x^2</tg-math>')).toBe(true);
  expect(isRichHtml('<tg-math-block>E = mc^2</tg-math-block>')).toBe(true);
});

test('details/summary, footer, aside, figure trigger the rich route', () => {
  expect(isRichHtml('<details><summary>t</summary>c</details>')).toBe(true);
  expect(isRichHtml('<footer>f</footer>')).toBe(true);
  expect(isRichHtml('<aside>pull quote</aside>')).toBe(true);
  expect(isRichHtml('<figure><img src="x"/></figure>')).toBe(true);
});

// --- isRichHtml: basic tags stay on the normal sendMessage route ------------

test('a body with ONLY basic tags is NOT rich', () => {
  expect(isRichHtml('<b>bold</b> and <i>italic</i>')).toBe(false);
  expect(isRichHtml('<code>x</code>')).toBe(false);
  expect(isRichHtml('<pre>block</pre>')).toBe(false);
  expect(isRichHtml('<a href="https://t.me">link</a>')).toBe(false);
  expect(isRichHtml('<blockquote>quote</blockquote>')).toBe(false);
  expect(isRichHtml('<tg-emoji emoji-id="123">👍</tg-emoji>')).toBe(false);
  expect(isRichHtml('<tg-spoiler>hidden</tg-spoiler>')).toBe(false);
  expect(isRichHtml('<span class="tg-spoiler">hidden</span>')).toBe(false);
});

test('plain text with no tags is NOT rich', () => {
  expect(isRichHtml('just a normal report, nothing fancy')).toBe(false);
});

test('a prefix with tg-emoji + bold window over basic text is NOT rich', () => {
  // The branded header (✳️ [window] 🔵 ANSWER) uses only tg-emoji + <b> — it
  // must NOT by itself flip a plain report onto the rich route.
  const prefixed = '<tg-emoji emoji-id="1">✳️</tg-emoji> [<b>win</b>] body text';
  expect(isRichHtml(prefixed)).toBe(false);
});

test('basic tags whose name is a prefix of a rich tag do not false-trigger', () => {
  // <s> (strike) must not match <summary>/<sub>/<sup>; <p> must match but <pre>
  // must NOT be treated as the rich <p>.
  expect(isRichHtml('<s>strike</s>')).toBe(false);
  expect(isRichHtml('<pre>code</pre>')).toBe(false);
});

test('mark/sub/sup are rich-only triggers', () => {
  expect(isRichHtml('<mark>marked</mark>')).toBe(true);
  expect(isRichHtml('<sub>2</sub>')).toBe(true);
  expect(isRichHtml('<sup>2</sup>')).toBe(true);
});

// --- validateRichHtml: limits ----------------------------------------------

test('a small rich body passes validation', () => {
  const r = validateRichHtml('<h1>Hi</h1><table><tr><td>a</td></tr></table>');
  expect(r.ok).toBe(true);
  expect(r.error).toBeUndefined();
});

test('over the 32768-char budget is rejected', () => {
  const big = '<p>' + 'x'.repeat(RICH_LIMITS.maxChars + 1) + '</p>';
  const r = validateRichHtml(big);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/too long/i);
});

test('over 500 blocks is rejected', () => {
  const many = '<ul>' + '<li>x</li>'.repeat(RICH_LIMITS.maxBlocks + 1) + '</ul>';
  const r = validateRichHtml(many);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/blocks/i);
});

test('over 20 table columns is rejected', () => {
  const cells = '<td>c</td>'.repeat(RICH_LIMITS.maxTableColumns + 1);
  const r = validateRichHtml(`<table><tr>${cells}</tr></table>`);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/column/i);
});

test('colspan counts toward the column limit', () => {
  // 19 single cells + one colspan=2 = 21 columns → over the 20 limit.
  const cells = '<td>c</td>'.repeat(19) + '<td colspan="2">wide</td>';
  const r = validateRichHtml(`<table><tr>${cells}</tr></table>`);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/column/i);
});

test('exactly 20 columns is allowed', () => {
  const cells = '<td>c</td>'.repeat(RICH_LIMITS.maxTableColumns);
  const r = validateRichHtml(`<table><tr>${cells}</tr></table>`);
  expect(r.ok).toBe(true);
});

test('over 50 media attachments is rejected', () => {
  const imgs = '<img src="https://x/a.jpg"/>'.repeat(RICH_LIMITS.maxMedia + 1);
  const r = validateRichHtml(imgs);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/media/i);
});

// --- rich-only <a> forms (anchors / in-document links) ----------------------

test('an in-document anchor target <a name="..."> triggers the rich route', () => {
  expect(isRichHtml('<a name="chapter-1"></a>')).toBe(true);
});

test('an in-document link <a href="#..."> triggers the rich route', () => {
  expect(isRichHtml('see <a href="#chapter-1">chapter 1</a>')).toBe(true);
});

test('a normal external link <a href="https://..."> stays BASIC (not rich)', () => {
  // An external http(s) link and a tg://user mention are basic inline tags in
  // BOTH the basic and rich HTML allowlists, so they must not flip a plain
  // report onto the rich path.
  expect(isRichHtml('<a href="https://t.me/">link</a>')).toBe(false);
  expect(isRichHtml('<a href="http://example.com">link</a>')).toBe(false);
  expect(isRichHtml('<a href="tg://user?id=123">mention</a>')).toBe(false);
});

test('mailto:/tel: links are rich-only (basic HTML only documents http/tg://user)', () => {
  expect(isRichHtml('<a href="mailto:user@example.com">mail</a>')).toBe(true);
  expect(isRichHtml('<a href="tel:+123456789">phone</a>')).toBe(true);
});

// --- table column validation: EVERY row, not just the first -----------------

test('a LATER over-wide table row is rejected (not only the first row)', () => {
  const wide = '<td>x</td>'.repeat(RICH_LIMITS.maxTableColumns + 1);
  const html = `<table><tr><td>a</td></tr><tr>${wide}</tr></table>`;
  const r = validateRichHtml(html);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/column/i);
});

test('every row within 20 columns passes (multi-row table)', () => {
  const row = '<tr>' + '<td>c</td>'.repeat(RICH_LIMITS.maxTableColumns) + '</tr>';
  const html = `<table>${row}${row}${row}</table>`;
  expect(validateRichHtml(html).ok).toBe(true);
});

test('a large but valid dense table passes (char limit counts TEXT, not markup)', () => {
  // 400 rows x 20 one-char cells = 8000 visible chars (well under 32768) and
  // 401 blocks (1 table + 400 tr, under 500). The RAW HTML is ~80k chars —
  // counting markup instead of visible text would falsely reject this valid
  // message.
  const row = '<tr>' + '<td>c</td>'.repeat(20) + '</tr>';
  const html = '<table>' + row.repeat(400) + '</table>';
  expect([...html].length).toBeGreaterThan(RICH_LIMITS.maxChars); // raw HTML is over
  const r = validateRichHtml(html);
  expect(r.ok).toBe(true); // but the visible TEXT is ~8000 chars → valid
});

test('rowspan carries a column into the next row (effective-column check)', () => {
  // Row 1: rowspan=2 colspan=20 → occupies all 20 cols of rows 1 AND 2.
  // Row 2: adds ONE more <td> → 21 effective columns → over the limit.
  const html = '<table>' + '<tr><td rowspan="2" colspan="20">wide</td></tr>' + '<tr><td>extra</td></tr>' + '</table>';
  const r = validateRichHtml(html);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/column/i);
});

test('a rowspan that does NOT push past 20 columns still passes', () => {
  // Row 1: rowspan=2 spanning 10 cols + 10 normal cols = 20.
  // Row 2: 10 cols (the rowspan still holds the other 10) = 20 effective.
  const html =
    '<table>' +
    '<tr><td rowspan="2" colspan="10">held</td>' +
    '<td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td></tr>' +
    '<tr><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td><td>a</td></tr>' +
    '</table>';
  expect(validateRichHtml(html).ok).toBe(true);
});

// --- validateRichHtml precision (no false positives) -----------------------

test('escaped entities count as their VISIBLE length, not raw spelling', () => {
  // 32768 visible "<" each written as the 4-char entity "&lt;" = ~131k raw chars
  // but only 32768 visible chars → must NOT be rejected.
  const html = '<p>' + '&lt;'.repeat(RICH_LIMITS.maxChars) + '</p>';
  expect([...html].length).toBeGreaterThan(RICH_LIMITS.maxChars); // raw is over
  expect(validateRichHtml(html).ok).toBe(true); // decoded text is exactly at limit
});

test('numeric entities also count as one visible char', () => {
  const html = '<p>' + '&#8230;'.repeat(RICH_LIMITS.maxChars) + '</p>';
  expect(validateRichHtml(html).ok).toBe(true);
});

// PR #120 review: escapeHtml (render/html.ts) now ALSO escapes quotes
// (js/incomplete-html-attribute-sanitization fix), so a body built with it can
// carry &quot;/&#39; where it previously never did. Both must still count as
// ONE visible char each, not their raw multi-char spelling, or a quote-heavy
// body would be falsely rejected as over budget.
test('escapeHtml-produced &quot; and &#39; each count as one visible char', () => {
  const html = '<p>' + '&quot;'.repeat(RICH_LIMITS.maxChars) + '</p>';
  expect([...html].length).toBeGreaterThan(RICH_LIMITS.maxChars); // raw is over
  expect(validateRichHtml(html).ok).toBe(true);
  const html2 = '<p>' + '&#39;'.repeat(RICH_LIMITS.maxChars) + '</p>';
  expect(validateRichHtml(html2).ok).toBe(true);
});

test('tg://emoji <img> does NOT consume the media budget', () => {
  // 60 custom-emoji images (tg://emoji) — over the 50 MEDIA limit if mis-counted,
  // but these are emoji, not attachments → must pass.
  const emojis = '<img src="tg://emoji?id=123" alt="x"/>'.repeat(60);
  const r = validateRichHtml('<p>' + emojis + '</p>');
  expect(r.ok).toBe(true);
});

test('real http(s) media still counts toward the 50-attachment limit', () => {
  const imgs = '<img src="https://x/a.jpg"/>'.repeat(RICH_LIMITS.maxMedia + 1);
  expect(validateRichHtml(imgs).ok).toBe(false);
});

test('a long checkbox task-list is not falsely rejected as over-nested', () => {
  // <input type="checkbox"> is a VOID element — it must not leak a nesting level.
  // 30 checklist items nested in one <ul> stay well under the 16-level limit.
  const items = '<li><input type="checkbox" checked>done</li>'.repeat(30);
  const r = validateRichHtml('<ul>' + items + '</ul>');
  expect(r.ok).toBe(true);
});

test('a bare checkbox <input> alone triggers the rich route', () => {
  expect(isRichHtml('<input type="checkbox" checked>done')).toBe(true);
  expect(isRichHtml('<input type="checkbox">todo')).toBe(true);
});

test('custom-emoji alt text IS counted toward the 32768 budget', () => {
  // A huge alt on a tg://emoji image: stripping the tag would drop it (0 chars)
  // and pass locally, then fail at the API. The alt must be counted.
  const bigAlt = 'a'.repeat(RICH_LIMITS.maxChars + 10);
  const html = `<p>hi</p><img src="tg://emoji?id=1" alt="${bigAlt}"/>`;
  const r = validateRichHtml(html);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/too long/i);
});

// --- normalizeRichHtml: basic-only constructs not in the rich allowlist ------

test('normalizeRichHtml rewrites <span class="tg-spoiler"> to <tg-spoiler>', async () => {
  const { normalizeRichHtml } = await import('../features/render/rich');
  expect(normalizeRichHtml('<span class="tg-spoiler">x</span>')).toBe('<tg-spoiler>x</tg-spoiler>');
  // Mixed with a rich tag (the realistic case): span normalized, table intact.
  const mixed = '<span class="tg-spoiler">secret</span><table><tr><td>a</td></tr></table>';
  expect(normalizeRichHtml(mixed)).toBe(
    '<tg-spoiler>secret</tg-spoiler><table><tr><td>a</td></tr></table>',
  );
});

test('normalizeRichHtml leaves the native <tg-spoiler> form untouched', async () => {
  const { normalizeRichHtml } = await import('../features/render/rich');
  expect(normalizeRichHtml('<tg-spoiler>x</tg-spoiler>')).toBe('<tg-spoiler>x</tg-spoiler>');
});

test('normalizeRichHtml handles nested spoiler spans without corruption', async () => {
  const { normalizeRichHtml } = await import('../features/render/rich');
  const nested = '<span class="tg-spoiler">outer <span class="tg-spoiler">inner</span> tail</span>';
  expect(normalizeRichHtml(nested)).toBe(
    '<tg-spoiler>outer <tg-spoiler>inner</tg-spoiler> tail</tg-spoiler>',
  );
});

test('normalizeRichHtml does NOT treat data-class as a real class', async () => {
  const { normalizeRichHtml } = await import('../features/render/rich');
  const dc = '<span data-class="tg-spoiler">x</span>';
  expect(normalizeRichHtml(dc)).toBe(dc); // unchanged
});

test('normalizeRichHtml leaves a non-spoiler span (and its close) untouched', async () => {
  const { normalizeRichHtml } = await import('../features/render/rich');
  const other = '<span class="foo">x</span>';
  expect(normalizeRichHtml(other)).toBe(other);
  // A spoiler span containing a nested NON-spoiler span: only the spoiler is
  // rewritten; the inner span's own </span> stays a </span>.
  const mixed = '<span class="tg-spoiler">a <span class="x">b</span> c</span>';
  expect(normalizeRichHtml(mixed)).toBe('<tg-spoiler>a <span class="x">b</span> c</tg-spoiler>');
});

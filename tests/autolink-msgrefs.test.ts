import { expect, test } from 'bun:test';
import { detectMsgRefs, findMsgRefMatches } from '../features/autolink-msgrefs/detect';
import { linkifyMsgRefs, msgRefUrl } from '../features/autolink-msgrefs/render';
import { detectRefs } from '../features/autolink-prs/detect';
import { linkifyRefs } from '../features/autolink-prs/render';
import type { GhRef } from '../features/autolink-prs/resolve';

// --- Detection ---

test('detect: a bare tg#<id> is found', () => {
  expect(detectMsgRefs('answered tg#1234 already')).toEqual([1234]);
});

test('detect: the tg prefix is case-insensitive', () => {
  expect(detectMsgRefs('TG#7 and Tg#8 and tG#9')).toEqual([7, 8, 9]);
});

test('detect: multiple refs, dedup by id, first-appearance order', () => {
  expect(detectMsgRefs('tg#1 then tg#22, tg#1 again')).toEqual([1, 22]);
});

test('detect: punctuation around the ref is fine', () => {
  expect(detectMsgRefs('(tg#10), see tg#11. and tg#12,')).toEqual([10, 11, 12]);
});

test('detect: a leading alphanumeric on the prefix disqualifies', () => {
  expect(detectMsgRefs('xtg#1 and abctg#42')).toEqual([]);
});

test('detect: a ref sandwiched between non-alnum punctuation is still found', () => {
  // The boundary rule only rejects ALPHANUMERIC neighbours, so `(`, `-`, `)`
  // around the ref are fine — `foo(tg#123)bar` and `foo-tg#123-bar` both detect.
  expect(detectMsgRefs('foo(tg#123)bar')).toEqual([123]);
  expect(detectMsgRefs('foo-tg#123-bar')).toEqual([123]);
});

test('detect: a trailing alphanumeric disqualifies', () => {
  expect(detectMsgRefs('tg#1a tg#42x')).toEqual([]);
});

test('detect: tg#0 is not a ref (must be [1-9]\\d*)', () => {
  expect(detectMsgRefs('tg#0 and tg#00')).toEqual([]);
});

test('detect: a bare #N (no tg prefix) is NOT a message ref', () => {
  // That namespace belongs to autolink-prs; msgrefs only owns the tg# form.
  expect(detectMsgRefs('#1234 and fixes #5')).toEqual([]);
});

test('detect: refs inside URLs are skipped', () => {
  expect(detectMsgRefs('see https://t.me/c/123/tg#1 for details')).toEqual([]);
});

test('detect: multiline text', () => {
  expect(detectMsgRefs('line one tg#9\nline two tg#10')).toEqual([9, 10]);
});

test('detect: empty and ref-free text', () => {
  expect(detectMsgRefs('')).toEqual([]);
  expect(detectMsgRefs('no refs here')).toEqual([]);
});

test('findMsgRefMatches: spans + ids for a multi-ref token-free run', () => {
  expect(findMsgRefMatches('tg#5')).toEqual([{ start: 0, end: 4, id: 5 }]);
  expect(findMsgRefMatches('tg#1234')).toEqual([{ start: 0, end: 7, id: 1234 }]);
});

// --- msgRefUrl: deep link only for supergroups/channels ---

test('msgRefUrl: a -100<rest> supergroup id → t.me/c link', () => {
  expect(msgRefUrl('-1001234567890', 42)).toBe('https://t.me/c/1234567890/42');
});

test('msgRefUrl: a private DM (positive id) has no public link → null', () => {
  expect(msgRefUrl('123456789', 42)).toBeNull();
});

test('msgRefUrl: a basic group (-<digits>, no -100 prefix) → null', () => {
  expect(msgRefUrl('-987654', 42)).toBeNull();
});

test('msgRefUrl: a -100 prefix with no/invalid trailing digits → null', () => {
  // The regex requires real digits after -100; a bare -100 or -100<nondigit>
  // is not a usable supergroup id.
  expect(msgRefUrl('-100', 42)).toBeNull();
  expect(msgRefUrl('-100abc', 42)).toBeNull();
});

test('msgRefUrl: missing/empty chat id → null', () => {
  expect(msgRefUrl(undefined, 1)).toBeNull();
  expect(msgRefUrl('', 1)).toBeNull();
});

// --- linkify: with a deep link (supergroup) ---

test('linkify: a tg#<id> with a url becomes an <a href>', () => {
  const out = linkifyMsgRefs('see tg#42 now', (id) => `https://t.me/c/99/${id}`);
  expect(out).toBe('see <a href="https://t.me/c/99/42">tg#42</a> now');
});

test('linkify: multiple refs each get their own anchor', () => {
  const out = linkifyMsgRefs('tg#1 and tg#2', (id) => `https://x/${id}`);
  expect(out).toBe('<a href="https://x/1">tg#1</a> and <a href="https://x/2">tg#2</a>');
});

// --- linkify: no url (private DM) → marked-but-unlinked styled ref ---

test('linkify: a null url renders a styled (bold-italic) reference, no link', () => {
  const out = linkifyMsgRefs('answered tg#7', () => null);
  // Bold-italic Unicode for "tg" + the digits left verbatim (the math block has
  // no digits). Not an <a>, not a bare token.
  expect(out).not.toContain('<a ');
  expect(out).toContain('#7');
  expect(out).toContain('𝒕𝒈'); // 'tg' in Mathematical Bold Italic
});

// --- tag-safety: never rewrite inside <a>/<pre>/<code> or a URL token ---

test('linkify: leaves tg#<id> inside an existing <a> untouched', () => {
  const html = '<a href="https://e">tg#5</a> and tg#6';
  const out = linkifyMsgRefs(html, (id) => `https://x/${id}`);
  // The inner tg#5 stays as-is (no nested link); only the outer tg#6 links.
  expect(out).toBe('<a href="https://e">tg#5</a> and <a href="https://x/6">tg#6</a>');
});

test('linkify: leaves tg#<id> inside <pre>/<code> untouched', () => {
  const html = '<pre><code>tg#5</code></pre> tg#6';
  const out = linkifyMsgRefs(html, (id) => `https://x/${id}`);
  expect(out).toBe('<pre><code>tg#5</code></pre> <a href="https://x/6">tg#6</a>');
});

test('linkify: respects a deeply-nested non-rewritable tag', () => {
  // The aDepth/preDepth counters handle multiple wrapping levels: the inner
  // ref inside <div><p><code> stays plain, the trailing outside ref links.
  const html = '<div><p><code>This tg#123 should not link</code></p></div> tg#9';
  const out = linkifyMsgRefs(html, (id) => `https://x/${id}`);
  expect(out).toBe(
    '<div><p><code>This tg#123 should not link</code></p></div> <a href="https://x/9">tg#9</a>',
  );
});

test('linkify: a token containing :// is never rewritten', () => {
  const html = 'https://host/tg#5 path';
  const out = linkifyMsgRefs(html, (id) => `https://x/${id}`);
  expect(out).toBe('https://host/tg#5 path');
});

test('linkify: no refs → body unchanged', () => {
  expect(linkifyMsgRefs('nothing here', () => 'https://x')).toBe('nothing here');
});

// --- Coexistence with autolink-prs: tg#<id> must NOT collide with #<id> ---
// The ROADMAP requirement: a `tg#3715` is a MESSAGE ref, never issue/PR #3715.

test('autolink-prs detect ignores tg#<id> (no collision at detection)', () => {
  // The PR detector's own boundary rule already rejects `tg#3715` (the `g`
  // before `#` is alphanumeric), so a message ref is never offered to gh.
  expect(detectRefs('done tg#3715')).toEqual([]);
  // A real bare #N alongside a tg#<id> still resolves on its own.
  expect(detectRefs('done tg#3715 and fixes #42')).toEqual([42]);
});

test('PR linkify never rewrites a tg#<id>, even with that number resolved', () => {
  // Simulate a body where #3715 IS a verified PR. The msgref pass links tg#3715
  // FIRST; the PR pass must then leave it alone (it is inside an <a>, and its
  // own boundary rule rejects `tg#3715` anyway). Only the standalone #3715 links.
  const refs = new Map<number, GhRef>([
    [3715, { number: 3715, title: 'PR', url: 'https://gh/pull/3715', kind: 'pr', state: 'OPEN', isDraft: false }],
  ]);
  const afterMsg = linkifyMsgRefs('reply to tg#3715 about #3715', () => null);
  const afterPr = linkifyRefs(afterMsg, refs);
  // The styled `𝒕𝒈#3715` ref keeps its `#3715` OUT of any github anchor: the
  // earlier weak assertion only checked the anchor TEXT wasn't `tg#`, but the bug
  // produced `𝒕𝒈<a …>#3715</a>` (the styled `𝒕𝒈` sits OUTSIDE the anchor), which
  // that check missed. Pin the whole styled token instead — `𝒕𝒈#3715` must remain
  // a single un-anchored run.
  expect(afterPr).toContain('𝒕𝒈#3715');
  expect(afterPr).not.toContain('𝒕𝒈<a ');
  expect(afterPr).not.toContain('𝒕𝒈#<a ');
  // Exactly ONE github anchor — the standalone `#3715`, not the message ref.
  expect(afterPr.match(/href="https:\/\/gh\/pull\/3715"/g)?.length).toBe(1);
  expect(afterPr).toContain('<a href="https://gh/pull/3715">#3715</a>');
});

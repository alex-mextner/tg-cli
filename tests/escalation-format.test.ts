// Unit tests for the pure decision-request-format validator
// (features/cli/escalation-format.ts) — the machine-checkable half of the
// decision-request-discipline skill enforced for --tag decision|question.
import { expect, test } from 'bun:test';
import { validateEscalationFormat } from '../features/cli/escalation-format';

// A body that satisfies EVERY required section, laid out as a structured Rich
// Message: table with pros/cons, a recommendation, a file:line "where to look",
// context prose, >=2 headings, a <ul>, and <hr> dividers.
const COMPLIANT = [
  '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
  '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
  '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
  '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
  '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
].join('\n');

test('a fully-compliant structured body passes with no missing sections', () => {
  const r = validateEscalationFormat(COMPLIANT);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test('plain prose fails every content + structure section', () => {
  const r = validateEscalationFormat('should we ship A or B?');
  expect(r.ok).toBe(false);
  // options/list, pros/cons, recommendation, where-to-look, context, headings,
  // list, hr — the whole checklist.
  expect(r.missing.length).toBeGreaterThanOrEqual(6);
});

test('a bare table (no recommendation/context/structure) is not enough', () => {
  const body = ['| Option | Cons |', '| --- | --- |', '| A | slow |'].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(false);
  const joined = r.missing.join('\n');
  expect(joined).toContain('recommendation');
  expect(joined).toContain('heading');
});

test('Russian recommendation / pros-cons / where-to-look keywords are recognized', () => {
  const body = [
    '<h3>Контекст</h3><p>Резолвер в features/foo.ts:42 выбирает не тот элемент при холодных мапах.</p><hr>',
    '<h3>Опции</h3><table><tr><th>Вариант</th><th>Плюсы</th><th>Минусы</th></tr>',
    '<tr><td>A</td><td>быстро</td><td>риск</td></tr></table><hr>',
    '<h3>Рекомендация</h3><ul><li>Рекомендую A, потому что быстрее</li></ul><hr>',
    '<h4>Где смотреть</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(true);
});

test('an inline comma-run enumeration ("плюсы: a, b, c, d") is flagged as a wall of text', () => {
  // Otherwise-structured, but the pros are jammed into one prose line.
  const body = [
    '<h3>Context</h3><p>features/foo.ts:42 misbehaves on cold maps quite often.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th></tr><tr><td>A</td><td>x</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>recommend A</li></ul>',
    'плюсы: быстро, безопасно, дешево, просто',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(false);
  expect(r.missing.join('\n')).toContain('Readability');
});

test('a recommendation-only single-item list is NOT an options section', () => {
  // A <ul> with one <li> (a recommendation) plus pros/cons words in prose must
  // not satisfy the Options requirement — no table, <2 list items.
  const body = [
    '<h3>Context</h3><p>features/foo.ts:42 misbehaves on cold maps sometimes.</p><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A because its pros outweigh its cons</li></ul><hr>',
    '<h4>Where to look</h4><p>features/foo.ts:42</p>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(false);
  expect(r.missing.join('\n')).toContain('Options');
});

test('a body with no concrete file reference fails the where-to-look requirement', () => {
  const body = [
    '<h3>Context</h3><p>The click resolver misbehaves on cold maps quite often now.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(false);
  expect(r.missing.join('\n')).toContain('Where to look');
});

test('a single run-on paragraph longer than the wall threshold is flagged', () => {
  const wall = 'A'.repeat(400);
  const body = [
    `<h3>Context</h3><p>${wall}</p><hr>`,
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>recommend A, see features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).toContain('Readability');
});

// --- Regression coverage for tg-cli#261 ---------------------------------
//
// Root cause: hasWallOfText split the body on LITERAL '\n' only. A fully
// structured Rich Message (headings/table/list/<hr>) typed or assembled as
// one continuous string — with no literal newline between sections — still
// renders as separate visual lines in Telegram (block-level tags force
// their own line), but the raw source string is one giant "line" whose
// character count trivially blows past WALL_LINE_CHARS the moment the
// content is realistic (a real file path, an extra table row, a second
// recommendation bullet). The reported "template passes / any real content
// fails" pattern is exactly this: the toy template joined into one line is
// 345 chars (just under the 350 threshold); the same shape with one real
// filename swapped in is 538. Fixed by giving hasWallOfText a virtual line
// break after each block-level tag boundary before scanning, so the same
// content produces the same result regardless of the caller's literal-\n
// formatting choice. See tg-cli#261 for the `tg --dry-run` transcript that
// reproduced this before the fix.
test('a realistic body assembled as ONE continuous line (no literal \\n) passes', () => {
  // Same content as COMPLIANT, but joined with '' instead of '\n' — the
  // exact shape that reproduced tg-cli#261 (fails before this fix, passes
  // after).
  const oneLine = COMPLIANT.replace(/\n/g, '');
  const r = validateEscalationFormat(oneLine);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test('a genuine run-on paragraph on one continuous line still fails Readability', () => {
  // The fix must not turn hasWallOfText into a no-op: an actual wall of
  // text glued to the rest of a one-line body is still a wall of text.
  const wall = 'A'.repeat(400);
  const oneLine = COMPLIANT.replace('The resolver in features/foo.ts:42 picks the wrong click target on cold maps.', wall).replace(
    /\n/g,
    '',
  );
  const r = validateEscalationFormat(oneLine);
  expect(r.ok).toBe(false);
  expect(r.missing.join('\n')).toContain('Readability');
});

test('a single long <li> item sharing a source line with its <h3> heading is still excluded', () => {
  // The Recommendation line below is "<h3>Recommendation</h3><ul><li>…</li></ul><hr>"
  // as ONE array element (no literal \n inside it), so pre-fix it starts
  // with "<h3", escapes the skip-list, and WOULD have been flagged as a
  // wall of text (this is new correct behavior, not a preserved one).
  // withVisualLineBreaks breaks BEFORE opening tags and AFTER closing ones,
  // so post-fix "<li>…</li>" lands on its own line and the skip-list's
  // "line starts with <li" exclusion applies there. Breaking after the
  // opening tag instead (splitting the element from its own content) would
  // defeat that exclusion and wrongly flag a long-but-valid list item.
  const longItem = 'x'.repeat(360);
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    `<h3>Recommendation</h3><ul><li>${longItem}</li></ul><hr>`,
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).not.toContain('Readability');
});

test('a long <blockquote> is excluded from the wall check, same as <pre>', () => {
  // blockquote joins the break set (it is block-level in Telegram, same as
  // <pre>) — it must also join the skip-list, or a long-but-legitimate
  // quoted block gets flagged post-normalization even though the
  // equally-long <pre> case does not.
  const longQuote = 'y'.repeat(360);
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    `<h3>Recommendation</h3><ul><li>see quote</li></ul><blockquote>${longQuote}</blockquote><hr>`,
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).not.toContain('Readability');
});

test('someone else\'s quoted words in a <blockquote> do NOT satisfy the Context prose requirement', () => {
  // Caught in review: hasWallOfText's skip-list gained blockquote (same as
  // pre) but hasContextProse's did not, so a body whose only ≥20-letter
  // non-table line was a QUOTED block (not the agent's own prose) could
  // satisfy "Context — a sentence of prose" via someone else's words. Both
  // skip-lists must agree on blockquote.
  const longQuote = 'z'.repeat(30);
  const body = [
    '<h3>Context</h3><blockquote>' + longQuote + '</blockquote><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>A</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
});

test('a <pre> code dump does NOT satisfy the Context prose requirement', () => {
  // Same class as the <blockquote> case above (caught in the same review
  // round): a <pre> code sample is even less the agent's own explanatory
  // prose than a quote. hasContextProse's skip-list must exclude pre/code
  // the same way hasWallOfText's already does.
  const body = [
    '<h3>Context</h3><pre>const r = await fetchSomethingFromApi(url);</pre><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>A</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
});

test('a one-line body with "Pros:" and its 3rd comma in DIFFERENT visual sections is not falsely flagged', () => {
  // INLINE_ENUM_RE must be scoped to the normalized (post-line-break) body,
  // not the raw one-line string — otherwise "Pros:" in the Context sentence
  // and the 3 commas in the (unrelated) Recommendation sentence match
  // across a section boundary that only exists once literal newlines are
  // removed, giving the same content two different verdicts depending on
  // the caller's newline formatting. Neither section alone has 3 commas
  // after a pros/cons label.
  const body =
    '<h3>Context</h3><p>Pros: see the table below for details.</p><hr>' +
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>fast</td><td>risky</td></tr></table><hr>' +
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster, safer, cheaper, and simpler</li></ul><hr>' +
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>';
  const r = validateEscalationFormat(body);
  expect(r.missing.join('\n')).not.toContain('Readability');
});

test('a genuine inline enumeration crammed into one <li> is still caught, in both newline and one-line form', () => {
  // INLINE_ENUM_RE moved to run per visual line (see above), not the whole
  // raw body — but it still runs BEFORE the table/list skip-list, so a real
  // "Плюсы: a, b, c," jammed into a single bullet (instead of one <li> per
  // item) is caught exactly as before, whether or not the caller used
  // literal newlines.
  const withNewlines = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>Плюсы: быстро, безопасно, дешево, просто</li></ul>',
  ].join('\n');
  expect(validateEscalationFormat(withNewlines).missing.join('\n')).toContain('Readability');

  const oneLine = withNewlines.replace(/\n/g, '');
  expect(validateEscalationFormat(oneLine).missing.join('\n')).toContain('Readability');
});

test('a real, non-template file path satisfies the where-to-look requirement', () => {
  // A real repo-relative workflow path. FILE_REF_RE does not special-case
  // the template's own "features/foo.ts:42" example (the other tests below
  // reuse it freely) — this test exists to confirm an unrelated, longer,
  // dot-prefixed real path matches the same way, not that the validator
  // treats "real" paths differently from the placeholder.
  const body = [
    '<h3>Context</h3><p>.github/workflows/self-hosted-runner-smoke.yml:1 flakes on cold docker starts.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>.github/workflows/self-hosted-runner-smoke.yml:1</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test('a 3-row Options table with short 2-word cells still counts as a real table', () => {
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    '<tr><td>A</td><td>fast build</td><td>risky call</td></tr>',
    '<tr><td>B</td><td>safe path</td><td>slow build</td></tr>',
    '<tr><td>C</td><td>middle ground</td><td>extra work</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>I recommend A because it is faster</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test('a 2-item Recommendation list is not penalized for having more than one bullet', () => {
  const body = [
    '<h3>Context</h3><p>The resolver in features/foo.ts:42 picks the wrong click target on cold maps.</p><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>',
    '<tr><td>A</td><td>fast</td><td>risky</td></tr><tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>A wins on speed</li><li>B loses on latency</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const r = validateEscalationFormat(body);
  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

// hasContextProse requires >=20 \p{L}/\p{N} characters SOMEWHERE on a
// single non-markup line — it is not scoped to the line under the "Context"
// heading, and tag names inside an unexcluded line (e.g. the "p" in
// `<p>`/`</p>`) count toward the total same as prose does. Both are
// consistent with this file's documented bias toward false positives over
// false negatives (see the file header): a real decision-request always has
// SOME real sentence somewhere, so scanning the whole body for one is
// deliberately generous, not scoped per-section. These tests pin the exact
// character count on a bare, tag-free line so the boundary is unambiguous;
// isolating it that way is required because a full compliant body has OTHER
// qualifying lines (e.g. the Context <p> sentence itself in COMPLIANT) that
// would satisfy this check regardless of a bare-string input's own length —
// these tests call validateEscalationFormat directly on a minimal string, not
// a full compliant body, precisely to isolate the 20-char boundary.
const CONTEXT_MISSING_LABEL = 'Context — a sentence of prose';

test('exactly 20 letter/digit chars of prose satisfies the Context requirement', () => {
  const r = validateEscalationFormat('A'.repeat(20));
  expect(r.missing.join('\n')).not.toContain(CONTEXT_MISSING_LABEL);
});

test('19 letter/digit chars of prose is one short and fails the Context requirement', () => {
  const r = validateEscalationFormat('A'.repeat(19));
  expect(r.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
});

test('20 Cyrillic letters (\\p{L}, non-ASCII) also satisfy the Context requirement', () => {
  // Rules out a counting bug specific to non-ASCII scripts — the reporter's
  // original claim was bilingual and did not specify which language broke.
  const r = validateEscalationFormat('ф'.repeat(20));
  expect(r.missing.join('\n')).not.toContain(CONTEXT_MISSING_LABEL);
});

test('a one-line structured body with NO real prose sentence still fails Context, same as its newline form', () => {
  // Caught in review of this same PR: hasContextProse originally split on
  // literal '\n' only (unlike hasWallOfText, which got the tg-cli#261
  // withVisualLineBreaks fix). A one-line body is one "line" starting with
  // "<h3" — not in hasContextProse's skip-list — so the >=20-char word count
  // ran over the WHOLE glued body including tag names ("h","3","C","o","n",
  // "t","e","x","t",…), trivially clearing 20 chars from markup alone and
  // auto-passing Context with zero real prose. The newline form of the exact
  // same content correctly fails. Both forms must agree.
  const body = [
    '<h3>Context</h3><hr>',
    '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr><tr><td>A</td><td>x</td><td>y</td></tr></table><hr>',
    '<h3>Recommendation</h3><ul><li>A</li></ul><hr>',
    '<h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>',
  ].join('\n');
  const oneLine = body.replace(/\n/g, '');

  const withNewlines = validateEscalationFormat(body);
  const glued = validateEscalationFormat(oneLine);
  expect(withNewlines.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
  expect(glued.missing.join('\n')).toContain(CONTEXT_MISSING_LABEL);
});

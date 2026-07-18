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

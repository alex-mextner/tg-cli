import { expect, test } from 'bun:test';
import {
  resolveTag,
  validateTag,
  CANONICAL_TAGS,
  ACCEPTED_TAGS,
  ACCEPTED_TAGS_LIST,
  ESCALATION_TAGS,
  REMOVED_QUESTION_TAG_HINT,
} from '../features/render/tag';

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

// --- The removed QUESTION tag has no branding left (tg-cli#301) ---
// resolveTag stays total: the word resolves to the not-known shape with no
// dot/fallback/pill, so nothing can ever render a "🟠 QUESTION" badge again.
test('resolveTag: QUESTION is off-list — no fallback, no dot, no pill cells', () => {
  for (const q of ['question', 'QUESTION']) {
    expect(resolveTag(q)).toEqual({ fallback: '', dot: '', cellDots: [], word: 'QUESTION', known: false });
  }
});

// --- Case-insensitive English input ---
test('resolveTag is case-insensitive for English input', () => {
  expect(resolveTag('answer').word).toBe('ANSWER');
  expect(resolveTag('answer').known).toBe(true);
  expect(resolveTag('Decision').word).toBe('DECISION');
  expect(resolveTag('  report  ').word).toBe('REPORT'); // trims surrounding space
});

// --- Russian aliases are NO LONGER resolved (lowercase-english only) ---
// resolveTag stays total (never throws), so a Cyrillic word resolves to the
// not-known shape. The CLI never reaches this — validateTag rejects Cyrillic at
// parse time before resolveTag runs — but the rendering helper must not crash on
// off-list input.
test('resolveTag no longer resolves Russian aliases (they are off-list)', () => {
  for (const cyrillic of ['ОТВЕТ', 'РЕШЕНИЕ', 'ПРОБЛЕМА', 'ОТЧЁТ', 'ОТЧЕТ']) {
    const r = resolveTag(cyrillic);
    expect(r.known).toBe(false);
    expect(r.fallback).toBe('');
    expect(r.dot).toBe('');
    expect(r.cellDots).toEqual([]);
  }
});

// --- An off-list input resolves to the not-known shape (no hard fail) ---
test('resolveTag: an off-list tag is NOT known, has no fallback/dot/cellDots, word is uppercased', () => {
  expect(resolveTag('wat')).toEqual({ fallback: '', dot: '', cellDots: [], word: 'WAT', known: false });
  expect(resolveTag('NOTAG')).toEqual({ fallback: '', dot: '', cellDots: [], word: 'NOTAG', known: false });
});

// --- The canonical-tag list is the single source of truth ---
test('CANONICAL_TAGS lists the four English canonicals', () => {
  expect([...CANONICAL_TAGS]).toEqual(['ANSWER', 'DECISION', 'PROBLEM', 'REPORT']);
});

test('ESCALATION_TAGS is exactly decision — an open question is a decision request', () => {
  expect([...ESCALATION_TAGS]).toEqual(['decision']);
  // Invariant behind the "one edit adds an escalation tag" promise: every
  // escalation tag must be an accepted tag, or the gates would key on a word
  // validateTag rejects before they ever run.
  expect(ESCALATION_TAGS.every((t) => ACCEPTED_TAGS.includes(t))).toBe(true);
});

// === validateTag: lowercase-english ONLY (ROADMAP "tg --tag: lowercase-english only") ===

test('ACCEPTED_TAGS are the lowercase-english spellings of the canonicals', () => {
  expect([...ACCEPTED_TAGS]).toEqual(['answer', 'decision', 'problem', 'report']);
  expect(ACCEPTED_TAGS_LIST).toBe('answer, decision, problem, report');
});

test('validateTag ACCEPTS each lowercase-english tag (returns null)', () => {
  for (const ok of ['answer', 'decision', 'problem', 'report']) {
    expect(validateTag(ok)).toBeNull();
  }
});

// === The removed `question` tag (tg-cli#301, CTO 2026-09-05) ===
// Not a generic off-list rejection: the agent's INTENT (ask the human) is right
// and only the vocabulary is wrong, so the error is a one-line redirect to
// --tag decision + the decision-request format.
test('validateTag REFUSES the removed question tag with the one-line decision hint', () => {
  const err = validateTag('question');
  expect(err).toBe(REMOVED_QUESTION_TAG_HINT);
  expect(err).toContain('--tag question was removed');
  expect(err).toContain('use --tag decision');
  expect(err).toContain('decision-request format');
  // A single line — it is a hint, not the 3-part off-list error.
  expect(err).not.toContain('\n');
  expect(err).not.toContain('Use one of:');
  // Trimmed like every other input.
  expect(validateTag('  question ')).toBe(REMOVED_QUESTION_TAG_HINT);
});

test('validateTag: the uppercase/mixed-case spellings of question fall to the generic off-list error', () => {
  for (const bad of ['QUESTION', 'Question']) {
    const err = validateTag(bad);
    expect(err).toContain(`invalid --tag '${bad}'`);
    expect(err).toContain('Use one of: answer, decision, problem, report');
  }
});

test('validateTag accepts surrounding whitespace (trimmed)', () => {
  expect(validateTag('  answer  ')).toBeNull();
  expect(validateTag('\treport\n')).toBeNull();
});

test('validateTag REJECTS uppercase / mixed-case english with a 3-part error', () => {
  for (const bad of ['ANSWER', 'Answer', 'DECISION', 'Report', 'PROBLEM']) {
    const err = validateTag(bad);
    expect(err).not.toBeNull();
    // WHAT — names the offending value
    expect(err).toContain(`invalid --tag '${bad}'`);
    // WHY — the rule
    expect(err).toContain('lowercase english');
    // HOW — the accepted set
    expect(err).toContain('Use one of: answer, decision, problem, report');
  }
});

test('validateTag REJECTS Cyrillic aliases with the helpful error', () => {
  for (const bad of ['ОТВЕТ', 'РЕШЕНИЕ', 'ПРОБЛЕМА', 'ОТЧЁТ', 'ответ']) {
    const err = validateTag(bad);
    expect(err).not.toBeNull();
    expect(err).toContain(`invalid --tag '${bad}'`);
    expect(err).toContain('lowercase english');
    expect(err).toContain('answer, decision, problem, report');
  }
});

test('validateTag REJECTS unknown words with the helpful error', () => {
  for (const bad of ['fixme', 'note', 'wat', 'answ', 'answers']) {
    const err = validateTag(bad);
    expect(err).not.toBeNull();
    expect(err).toContain(`invalid --tag '${bad}'`);
    expect(err).toContain('Use one of: answer, decision, problem, report');
  }
});

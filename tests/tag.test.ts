import { expect, test } from 'bun:test';
import { resolveTag, validateTag, CANONICAL_TAGS, ACCEPTED_TAGS, ACCEPTED_TAGS_LIST } from '../features/render/tag';

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

import { expect, test } from 'bun:test';
import {
  candidatePmIds,
  classifyPmWhyFailure,
  composeNextCard,
  findMatchingPr,
  parseNextCommand,
  parsePmWhyJson,
  type NextCardInput,
  type PmWhyJson,
} from '../features/tg-ctl/next-command';
import type { PrRef } from '../features/tg-ctl/tasks-command';
import type { PaneGitState } from '../features/tg-ctl/git-state';

test('parseNextCommand: ticket id required, tolerates @botname and extra whitespace', () => {
  expect(parseNextCommand('/next')).toBeNull();
  expect(parseNextCommand('/next   ')).toBeNull();
  expect(parseNextCommand('/next HYP-1033')).toEqual({ ticketId: 'HYP-1033' });
  expect(parseNextCommand('/next@mybot HYP-1033')).toEqual({ ticketId: 'HYP-1033' });
  // extra tokens are ignored — only the first is the ticket id
  expect(parseNextCommand('/next HYP-1033 extra stuff')).toEqual({ ticketId: 'HYP-1033' });
});

test('candidatePmIds: as-typed, task:-qualified, and project-guessed from <PREFIX>-<N>', () => {
  expect(candidatePmIds('HYP-1033')).toEqual(['HYP-1033', 'task:HYP-1033', 'task:HYP:HYP-1033']);
  // a bare pm id (manually-created item, no ticket behind it) — only two candidates, no
  // project guess since it doesn't match <PREFIX>-<N>
  expect(candidatePmIds('w1')).toEqual(['w1', 'task:w1']);
  // already a full pm id — the task: prefix candidate would be a no-op duplicate, so it's
  // not added a second time
  expect(candidatePmIds('task:HYP:HYP-1033')).toEqual(['task:HYP:HYP-1033']);
  // leading # stripped (GitHub-issue-style ids, e.g. pm-cli's own tracker)
  expect(candidatePmIds('#16')).toEqual(['16', 'task:16']);
});

const prA: PrRef = { number: 200, url: 'https://gh/pr/200', title: 'fix HYP-1033 thing', ci: 'pass', review: 'approved' };
const prB: PrRef = { number: 201, url: 'https://gh/pr/201', title: 'unrelated', body: 'Closes HYP-1033', ci: 'fail' };
const prNumeric: PrRef = { number: 5, url: 'https://gh/pr/5', title: 'fix #117 whatever', ci: 'pending' };

test('findMatchingPr: Linear-style ref matches literal text with word boundaries, highest PR wins', () => {
  expect(findMatchingPr('HYP-1033', [prA, prB])?.number).toBe(201); // both match, higher number wins
  expect(findMatchingPr('HYP-1099', [prA, prB])).toBeNull();
  // a substring must not false-match (word boundary)
  expect(findMatchingPr('HYP-103', [prA])).toBeNull();
});

// Review round 2 (tg-cli#289): plain `\b` treats '-' as non-word, so `\bHYP-1033\b` was
// satisfied by the '-' immediately following "1033" — falsely matching inside a longer
// hyphenated compound. A ticket token spans [A-Za-z0-9-]; neither side of the match may be
// adjacent to another character from that set.
test('findMatchingPr: a hyphenated compound does NOT shadow-match a shorter ticket id (the \\b bug)', () => {
  const suffixed: PrRef = { number: 300, url: 'https://gh/pr/300', title: 'Fix HYP-1033-follow-up work', ci: 'pass' };
  expect(findMatchingPr('HYP-1033', [suffixed])).toBeNull();
  const prefixed: PrRef = { number: 301, url: 'https://gh/pr/301', title: 'See PREFIX-HYP-1033 for context', ci: 'pass' };
  expect(findMatchingPr('HYP-1033', [prefixed])).toBeNull();
  // the exact id, standing alone or bounded by non-token punctuation, still matches
  const exact: PrRef = { number: 302, url: 'https://gh/pr/302', title: 'fix HYP-1033 (again)', ci: 'pass' };
  expect(findMatchingPr('HYP-1033', [exact])?.number).toBe(302);
});

test('findMatchingPr: purely numeric ids require the # anchor (fewer false positives)', () => {
  expect(findMatchingPr('117', [prNumeric])?.number).toBe(5);
  expect(findMatchingPr('#117', [prNumeric])?.number).toBe(5);
  // "17" is a substring of "117" but not "#17\b" — must not match
  expect(findMatchingPr('17', [prNumeric])).toBeNull();
});

test('findMatchingPr: no PRs, or empty ticket id, is null', () => {
  expect(findMatchingPr('HYP-1', [])).toBeNull();
  expect(findMatchingPr('', [prA])).toBeNull();
  expect(findMatchingPr('#', [prA])).toBeNull();
});

// classifyPmWhyFailure: exit 2 is OVERLOADED between pm-cli's own "no such work item" and
// argparse's generic "unrecognized arguments" (what a `pm` predating --json, pm-cli#18, prints
// for EVERY id). Only the former may report 'not-found' — anything else, including a stale `pm`
// binary, must be 'error', or /next silently reports every ticket as untracked (advisor catch).
test('classifyPmWhyFailure: exit 2 + "no work item" is not-found', () => {
  expect(classifyPmWhyFailure(2, 'error: no work item `w1`')).toBe('not-found');
  expect(classifyPmWhyFailure(2, 'Error: No Work Item `foo`')).toBe('not-found'); // case-insensitive
});

test('classifyPmWhyFailure: exit 2 for any OTHER reason is error, not not-found', () => {
  // this is the exact live failure mode: a `pm` binary without --json (pre pm-cli#18)
  expect(classifyPmWhyFailure(2, 'usage: pm [-h] [--version] <command> ...\npm: error: unrecognized arguments: --json')).toBe('error');
  expect(classifyPmWhyFailure(2, '')).toBe('error');
});

test('classifyPmWhyFailure: non-2 exit codes are always error', () => {
  expect(classifyPmWhyFailure(1, 'Traceback...')).toBe('error');
  expect(classifyPmWhyFailure(127, 'pm: command not found')).toBe('error');
});

function validWhyJson(): Record<string, unknown> {
  return {
    id: 'w1',
    title: 't',
    state: 'seen',
    pm_labels: ['pm.stage:intake'],
    evidence: [{ kind: 'task-record', uri: 'https://x', observed_at: 't' }],
    errors: [],
    next: { terminal: false, unknown_state: false, moves: [{ state: 'classified', missing_evidence: [] }] },
  };
}

test('parsePmWhyJson: accepts a well-formed payload', () => {
  const parsed = parsePmWhyJson(JSON.stringify(validWhyJson()));
  expect(parsed.id).toBe('w1');
  expect(parsed.next.moves).toHaveLength(1);
});

// P1 (review catch, tg-cli#289): an unvalidated cast let a version-drifted or truncated `pm`
// payload reach composeNextCard's dereferences and throw INSIDE the daemon's per-action loop —
// which drops every action still queued behind it in that poll batch. parsePmWhyJson must reject
// these BEFORE they reach render code, so the daemon degrades to a normal 'error' card instead.
test('parsePmWhyJson: rejects malformed/invalid-JSON payloads instead of returning a broken object', () => {
  expect(() => parsePmWhyJson('not json')).toThrow();
  expect(() => parsePmWhyJson('null')).toThrow();
  expect(() => parsePmWhyJson('{}')).toThrow();
  expect(() => parsePmWhyJson('[]')).toThrow();
  expect(() => parsePmWhyJson(JSON.stringify({ ...validWhyJson(), pm_labels: 'not-an-array' }))).toThrow();
  expect(() => parsePmWhyJson(JSON.stringify({ ...validWhyJson(), next: null }))).toThrow();
  expect(() => parsePmWhyJson(JSON.stringify({ ...validWhyJson(), next: { terminal: false, unknown_state: false, moves: 'nope' } }))).toThrow();
  expect(() => parsePmWhyJson(JSON.stringify({ ...validWhyJson(), evidence: [{ kind: 'x' }] }))).toThrow(); // evidence entry missing uri
});

// Review round 2 (tg-cli#289): the first-pass validator checked every field composeNextCard
// dereferences, but missed two: `missing_evidence` array ELEMENTS (checked only Array.isArray,
// not that each entry is a string — composeNextCard calls `.map(escapeHtml)` on them, which
// throws on `null`), and `project` (unused by the renderer, but the DAEMON feeds it straight into
// agent-match.ts's matchWindows before any card is composed). Both crashed inside the daemon's
// sequential per-action loop, after the batch offset was already persisted — silently dropping
// every later action in that batch. These pin both closed.
test('parsePmWhyJson: rejects a non-string missing_evidence element (would crash escapeHtml at render time)', () => {
  const bad = { ...validWhyJson(), next: { terminal: false, unknown_state: false, moves: [{ state: 'ready', missing_evidence: [null] }] } };
  expect(() => parsePmWhyJson(JSON.stringify(bad))).toThrow();
});

test('parsePmWhyJson: rejects a non-string project (the DAEMON feeds it to matchWindows before any card renders)', () => {
  expect(() => parsePmWhyJson(JSON.stringify({ ...validWhyJson(), project: 123 }))).toThrow();
  expect(() => parsePmWhyJson(JSON.stringify({ ...validWhyJson(), project: { name: 'HYP' } }))).toThrow();
  // undefined (the field simply absent) is still valid — `project` is optional
  expect(() => parsePmWhyJson(JSON.stringify(validWhyJson()))).not.toThrow();
});

function whyItem(overrides: Partial<PmWhyJson> = {}): PmWhyJson {
  return {
    id: 'task:HYP:HYP-1033',
    title: 'Fix the thing',
    state: 'ticketed',
    project: 'HYP',
    pm_labels: ['pm.stage:intake', 'pm.health:healthy'],
    evidence: [],
    errors: [],
    next: { terminal: false, unknown_state: false, moves: [{ state: 'ready', missing_evidence: [] }] },
    ...overrides,
  };
}

function baseInput(overrides: Partial<NextCardInput> = {}): NextCardInput {
  return {
    ticketId: 'HYP-1033',
    why: { ok: true, data: whyItem() },
    git: { ok: false, reason: 'no-scope' },
    pr: { ok: false, reason: 'no-scope' },
    ...overrides,
  };
}

test('composeNextCard: pm why not-found renders an explicit not-found card, no other sections', () => {
  const html = composeNextCard(baseInput({ why: { ok: false, reason: 'not-found' } }));
  expect(html).toContain('no pm work item found');
  expect(html).toContain('HYP-1033');
  expect(html).not.toContain('git:');
});

test('composeNextCard: pm why hard error renders distinctly from not-found', () => {
  const html = composeNextCard(baseInput({ why: { ok: false, reason: 'error' } }));
  expect(html).toContain("pm why failed");
});

test('composeNextCard: happy path — title link, state+labels, next moves, git, PR/CI all present', () => {
  const html = composeNextCard(
    baseInput({
      why: {
        ok: true,
        data: whyItem({
          evidence: [{ kind: 'task-record', uri: 'https://linear.app/x/HYP-1033', observed_at: 't' }],
        }),
      },
      git: { ok: true, state: { branch: 'main', uncommittedCount: 0 } },
      pr: { ok: true, pr: { number: 42, url: 'https://gh/pr/42', title: 'x', ci: 'pass', review: 'approved' } },
    }),
  );
  expect(html).toContain('href="https://linear.app/x/HYP-1033"');
  expect(html).toContain('task:HYP:HYP-1033');
  expect(html).toContain('state: <b>ticketed</b>');
  expect(html).toContain('pm.stage:intake');
  expect(html).toContain('next: ready');
  expect(html).toContain('git: main (clean)');
  expect(html).toContain('href="https://gh/pr/42"');
  expect(html).toContain('#42');
  expect(html).toContain('✓'); // CI pass glyph
  expect(html).toContain('✅'); // review approved glyph
});

test('composeNextCard: header has no link when there is no task-record evidence', () => {
  const html = composeNextCard(baseInput());
  expect(html).not.toContain('<a href');
  expect(html).toContain('task:HYP:HYP-1033');
});

test('composeNextCard: next moves list missing evidence per move', () => {
  const html = composeNextCard(
    baseInput({
      why: {
        ok: true,
        data: whyItem({
          next: {
            terminal: false,
            unknown_state: false,
            moves: [
              { state: 'deployed', missing_evidence: ['deployment'] },
              { state: 'parked', missing_evidence: [] },
            ],
          },
        }),
      },
    }),
  );
  expect(html).toContain('deployed (needs deployment)');
  expect(html).toContain('parked');
});

test('composeNextCard: terminal and unknown-state next blocks render distinct text', () => {
  const terminal = composeNextCard(
    baseInput({ why: { ok: true, data: whyItem({ next: { terminal: true, unknown_state: false, moves: [] } }) } }),
  );
  expect(terminal).toContain('terminal — no further moves');

  const unknown = composeNextCard(
    baseInput({ why: { ok: true, data: whyItem({ next: { terminal: false, unknown_state: true, moves: [] } }) } }),
  );
  expect(unknown).toContain('unknown state');
});

test('composeNextCard: git and PR sections fail INDEPENDENTLY without blanking the rest of the card', () => {
  // git resolved, PR/CI has no project scope (gh never even ran) — the card still shows
  // the pm-why-derived sections plus the live git status.
  const html = composeNextCard(
    baseInput({
      git: { ok: true, state: { branch: 'feature/x', uncommittedCount: 3 } },
      pr: { ok: false, reason: 'no-scope' },
    }),
  );
  expect(html).toContain('state: <b>ticketed</b>');
  expect(html).toContain('git: feature/x (3 files changed)');
  expect(html).toContain('PR/CI: — (no project scope resolved)');
});

test('composeNextCard: git unavailable (spawn/parse failure) is distinct from no-scope', () => {
  const html = composeNextCard(baseInput({ git: { ok: false, reason: 'unavailable' } }));
  expect(html).toContain('git: — (unavailable)');
});

test('composeNextCard: PR/CI resolved scope but no matching PR', () => {
  const html = composeNextCard(baseInput({ pr: { ok: true, pr: null } }));
  expect(html).toContain('PR/CI: — (no matching PR found)');
});

// P2 (review catch, tg-cli#289): a FAILED gh lookup must render distinctly from "gh ran, found
// nothing" — collapsing the two fabricates an absence result for what might be an auth failure,
// missing binary, or timeout.
test('composeNextCard: PR/CI gh unavailable renders distinctly from "no matching PR found"', () => {
  const html = composeNextCard(baseInput({ pr: { ok: false, reason: 'unavailable' } }));
  expect(html).toContain('PR/CI: — (gh unavailable)');
  expect(html).not.toContain('no matching PR found');
});

test('composeNextCard: detached HEAD renders explicitly, not a blank branch', () => {
  const html = composeNextCard(baseInput({ git: { ok: true, state: { branch: '', uncommittedCount: 0 } } }));
  expect(html).toContain('git: detached HEAD (clean)');
});

test('composeNextCard: pm why errors[] surface as a warning line', () => {
  const html = composeNextCard(baseInput({ why: { ok: true, data: whyItem({ errors: ['stale evidence detected'] }) } }));
  expect(html).toContain('⚠ stale evidence detected');
});

test('composeNextCard: escapes HTML in title/state/errors (no raw injection into the rich message)', () => {
  const html = composeNextCard(
    baseInput({
      why: {
        ok: true,
        data: whyItem({ title: '<script>alert(1)</script>', errors: ['<b>bad</b>'] }),
      },
    }),
  );
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
});

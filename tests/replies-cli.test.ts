import { expect, test } from 'bun:test';
import { runReplies, type RepliesCliDeps } from '../features/replies/cli';
import { serializeHistoryRecord, type HistoryRecord } from '../features/replies/history';
import { buildOutboundHistoryRecords } from '../features/replies/outbound';

const rec = (over: Partial<HistoryRecord>): HistoryRecord => ({
  ts: 1700000000,
  message_id: 1,
  direction: 'user',
  from: 'Alex',
  text: 'hello',
  pane: '%1',
  ...over,
});

const HISTORY: HistoryRecord[] = [
  rec({ ts: 1700000000, message_id: 10, direction: 'user', text: 'deploy the canary', pane: '%1' }),
  rec({ ts: 1700000060, message_id: 11, direction: 'agent', from: 'agent', text: 'deployed OK', pane: '%1' }),
  rec({ ts: 1700000120, message_id: 12, direction: 'user', text: 'roll it back', pane: '%2' }),
];

function makeDeps(over: Partial<RepliesCliDeps> = {}): { deps: RepliesCliDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: RepliesCliDeps = {
    readHistory: () => HISTORY.map(serializeHistoryRecord).join('\n') + '\n',
    detectPane: () => '%1',
    resolveWindow: () => [], // default: no tmux windows resolve (overridden per test)
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: (m) => err.push(m),
    ...over,
  };
  return { deps, out, err };
}

test('runReplies: returns null when argv[0] is not "replies" (passes through to send)', () => {
  const { deps } = makeDeps();
  expect(runReplies(['just a message'], deps)).toBeNull();
  expect(runReplies([], deps)).toBeNull();
});

test('runReplies: default scope = detected pane, default direction = user', () => {
  const { deps, out } = makeDeps();
  const code = runReplies(['replies'], deps);
  expect(code).toBe(0);
  // pane %1, user only → message 10 (not 11 agent, not 12 pane %2)
  expect(out.length).toBe(1);
  expect(out[0]).toBe('[T] #10 deploy the canary');
});

test('runReplies: `all` in the detected pane shows both directions with markers', () => {
  const { deps, out } = makeDeps();
  runReplies(['replies', 'all'], deps);
  expect(out).toEqual(['← [T] #10 deploy the canary', '→ [T] #11 deployed OK']);
});

test('runReplies: --all-sessions ignores the pane scope', () => {
  const { deps, out } = makeDeps();
  runReplies(['replies', 'user', '--all-sessions'], deps);
  expect(out).toEqual(['[T] #10 deploy the canary', '[T] #12 roll it back']);
});

test('runReplies: --session overrides the detected pane', () => {
  const { deps, out } = makeDeps();
  runReplies(['replies', 'user', '--session', '%2'], deps);
  expect(out).toEqual(['[T] #12 roll it back']);
});

test('runReplies: --session %N (pane id) is passed through WITHOUT calling resolveWindow', () => {
  let called = 0;
  const { deps, out } = makeDeps({
    resolveWindow: () => {
      called += 1;
      return [];
    },
  });
  runReplies(['replies', 'user', '--session', '%2'], deps);
  expect(called).toBe(0); // a %-prefixed arg is a pane id, never a window lookup
  expect(out).toEqual(['[T] #12 roll it back']);
});

test('runReplies: --session <windowName> resolves to its panes and scopes recall', () => {
  const { deps, out } = makeDeps({
    resolveWindow: (name) => (name === 'ext' ? ['%2'] : []),
  });
  runReplies(['replies', 'user', '--session', 'ext'], deps);
  expect(out).toEqual(['[T] #12 roll it back']); // %2 is the only pane of window "ext"
});

test('runReplies: --session <windowName> unions duplicate window names across sessions', () => {
  const { deps, out } = makeDeps({
    resolveWindow: (name) => (name === 'work' ? ['%1', '%2'] : []),
  });
  runReplies(['replies', 'all', '--session', 'work'], deps);
  // %1 (#10 user, #11 agent) ∪ %2 (#12 user)
  expect(out).toEqual(['← [T] #10 deploy the canary', '→ [T] #11 deployed OK', '← [T] #12 roll it back']);
});

test('runReplies: --session matches EXACTLY, not by prefix (ext ≠ "ext: diagram")', () => {
  const resolveWindow = (name: string): string[] => {
    if (name === 'ext') return ['%1'];
    if (name === 'ext: diagram') return ['%2'];
    return [];
  };
  const a = makeDeps({ resolveWindow });
  runReplies(['replies', 'user', '--session', 'ext'], a.deps);
  expect(a.out).toEqual(['[T] #10 deploy the canary']); // only %1

  const b = makeDeps({ resolveWindow });
  runReplies(['replies', 'user', '--session', 'ext: diagram'], b.deps);
  expect(b.out).toEqual(['[T] #12 roll it back']); // only %2
});

test('runReplies: an unknown window name → exit 1 + a clear error, never a silent empty', () => {
  const { deps, out, err } = makeDeps({ resolveWindow: () => [] });
  const code = runReplies(['replies', 'user', '--session', 'nope'], deps);
  expect(code).toBe(1);
  expect(out).toEqual([]); // nothing printed to stdout
  expect(err.join('\n')).toContain("no tmux window named 'nope'");
});

test('runReplies: find filters by query within the scope', () => {
  const { deps, out } = makeDeps({ detectPane: () => null });
  runReplies(['replies', 'all', 'find', 'roll', '--all-sessions'], deps);
  expect(out).toEqual(['→ [T] #12 roll it back'.replace('→', '←')]); // #12 is a user message
});

test('runReplies: --json emits a single JSON array line', () => {
  const { deps, out } = makeDeps();
  runReplies(['replies', 'all', '--json'], deps);
  expect(out.length).toBe(1);
  const parsed = JSON.parse(out[0]);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.map((r: { id: number }) => r.id)).toEqual([10, 11]);
  expect(parsed[0].ts).toBe(1700000000 * 1000); // ms
});

test('runReplies: empty result prints a friendly "no messages" note (not JSON)', () => {
  const { deps, out } = makeDeps({ readHistory: () => null });
  const code = runReplies(['replies'], deps);
  expect(code).toBe(0);
  expect(out.length).toBe(1);
  expect(out[0].toLowerCase()).toContain('no ');
});

test('runReplies: empty result with --json still prints an empty array', () => {
  const { deps, out } = makeDeps({ readHistory: () => null });
  runReplies(['replies', '--json'], deps);
  expect(out).toEqual(['[]']);
});

test('runReplies: --help prints usage and exits 0', () => {
  const { deps, out } = makeDeps();
  const code = runReplies(['replies', '--help'], deps);
  expect(code).toBe(0);
  expect(out.join('\n')).toContain('tg replies');
});

test('runReplies: a bad argument prints the error + exits 1', () => {
  const { deps, err } = makeDeps();
  const code = runReplies(['replies', 'find'], deps);
  expect(code).toBe(1);
  expect(err.join('\n').toLowerCase()).toContain('find requires a query');
});

test('runReplies: invalid regex is a clean error, not a crash', () => {
  const { deps, err } = makeDeps();
  const code = runReplies(['replies', 'all', 'find', '(', '--regex', '--all-sessions'], deps);
  expect(code).toBe(1);
  expect(err.join('\n').toLowerCase()).toContain('regex');
});

test('runReplies: -n limits the rendered count', () => {
  const many: HistoryRecord[] = [];
  for (let i = 0; i < 5; i++) many.push(rec({ ts: 1700000000 + i, message_id: i, direction: 'user', pane: '%9' }));
  const { deps, out } = makeDeps({
    readHistory: () => many.map(serializeHistoryRecord).join('\n'),
    detectPane: () => '%9',
  });
  runReplies(['replies', 'user', '-n', '2'], deps);
  expect(out.map((l) => l.split('#')[1].split(' ')[0])).toEqual(['3', '4']); // last 2
});

// tg-cli#131 follow-up: buildOutboundHistoryRecords writes one history record
// per outbound message_id (a >4096 split / media-group album), tagged with a
// shared groupId, so the plain listing must collapse them back to ONE line —
// otherwise a single logical send would print N times (review caught this on
// the initial fix). Built via the REAL production function (not hand-rolled
// records) so this exercises the actual groupId the write path stamps.
test('runReplies: a multi-part send (3 ids) prints as ONE line in the plain listing', () => {
  const multiPart = buildOutboundHistoryRecords([301, 302, 303], '[3 photos]', 1700000300, '%3', 'grp-token');
  const { deps, out } = makeDeps({
    readHistory: () => multiPart.map(serializeHistoryRecord).join('\n'),
    detectPane: () => '%3',
  });
  runReplies(['replies', 'agent'], deps);
  expect(out).toEqual(['[T] #301 [3 photos]']); // ONE line, not three
});

// The SAME multi-part history, but --json: every id must stay individually
// present so a reply anchored to id 302 (the album's 2nd item) is findable
// via `select(.id == 302)` — the exact scenario the review comment reported.
test('runReplies: --json exposes EVERY id of a multi-part send, uncollapsed', () => {
  const multiPart = buildOutboundHistoryRecords([301, 302, 303], '[3 photos]', 1700000300, '%3', 'grp-token');
  const { deps, out } = makeDeps({
    readHistory: () => multiPart.map(serializeHistoryRecord).join('\n'),
    detectPane: () => '%3',
  });
  runReplies(['replies', 'agent', '--json'], deps);
  const rows = JSON.parse(out[0]) as Array<{ id: number | null }>;
  const secondAlbumItem = rows.find((r) => r.id === 302); // the reported bug case
  expect(secondAlbumItem).toBeDefined();
  expect(rows.map((r) => r.id)).toEqual([301, 302, 303]);
});

// `-n`/`--limit` now counts LOGICAL sends, not raw records — for `--json`
// too, not only the plain listing. Three sends: two single-record, then a
// 3-id multi-part send in the tail. `-n 2` keeps the LAST 2 SENDS (send #2 +
// the multi-part one) = 4 raw records, so `--json -n 2` returns 4 rows, not
// 2 — a documented contract change for any consumer that assumed
// `--json -n N` caps the row count at N. The oldest send (#1) is correctly
// dropped entirely.
test('runReplies: --json -n 2 keeps a tail multi-part send WHOLE (4 rows, not 2)', () => {
  const history = [
    ...buildOutboundHistoryRecords([99], 'oldest — dropped by -n 2', 1699999900, '%3', 'unused'),
    ...buildOutboundHistoryRecords([100], 'kept single', 1700000000, '%3', 'unused'),
    ...buildOutboundHistoryRecords([301, 302, 303], '[3 photos]', 1700000300, '%3', 'grp-token'),
  ];
  const { deps, out } = makeDeps({
    readHistory: () => history.map(serializeHistoryRecord).join('\n'),
    detectPane: () => '%3',
  });
  runReplies(['replies', 'agent', '--json', '-n', '2'], deps);
  const rows = JSON.parse(out[0]) as Array<{ id: number | null }>;
  expect(rows.map((r) => r.id)).toEqual([100, 301, 302, 303]); // 2 sends, tail send whole
});

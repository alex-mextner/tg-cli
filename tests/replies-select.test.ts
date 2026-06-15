import { expect, test } from 'bun:test';
import {
  filterByDirection,
  filterByPane,
  searchHistory,
  selectHistory,
  formatLine,
  formatLines,
  buildJsonOutput,
  type HistoryRecord,
} from '../features/replies/select';

const R = (over: Partial<HistoryRecord>): HistoryRecord => ({
  ts: 1000,
  message_id: 1,
  direction: 'user',
  from: 'Alex',
  text: 'hello',
  pane: '%1',
  ...over,
});

const sample: HistoryRecord[] = [
  R({ ts: 1700000000, message_id: 10, direction: 'user', from: 'Alex', text: 'deploy the canary', pane: '%1' }),
  R({ ts: 1700000060, message_id: 11, direction: 'agent', from: 'agent', text: 'deployed canary OK', pane: '%1' }),
  R({ ts: 1700000120, message_id: 12, direction: 'user', from: 'Alex', text: 'roll it BACK now', pane: '%2' }),
  R({ ts: 1700000180, message_id: 13, direction: 'agent', from: 'agent', text: 'rolled back', pane: '%2' }),
];

test('filterByDirection: user keeps inbound only', () => {
  expect(filterByDirection(sample, 'user').map((r) => r.message_id)).toEqual([10, 12]);
});

test('filterByDirection: agent keeps outbound only', () => {
  expect(filterByDirection(sample, 'agent').map((r) => r.message_id)).toEqual([11, 13]);
});

test('filterByDirection: all keeps everything', () => {
  expect(filterByDirection(sample, 'all').length).toBe(4);
});

test('filterByPane: scopes to one pane; null pane = no scope', () => {
  expect(filterByPane(sample, '%1').map((r) => r.message_id)).toEqual([10, 11]);
  expect(filterByPane(sample, null).length).toBe(4);
});

test('filterByPane: records with a null pane never match a concrete pane scope', () => {
  const withNull = [...sample, R({ message_id: 99, pane: null, direction: 'agent' })];
  expect(filterByPane(withNull, '%1').map((r) => r.message_id)).toEqual([10, 11]);
});

test('searchHistory: case-insensitive substring', () => {
  expect(searchHistory(sample, 'CANARY', false).map((r) => r.message_id)).toEqual([10, 11]);
  expect(searchHistory(sample, 'back', false).map((r) => r.message_id)).toEqual([12, 13]);
});

test('searchHistory: regex mode', () => {
  // `roll.*back` matches both "roll it BACK now" and "rolled back".
  expect(searchHistory(sample, 'roll.*back', true).map((r) => r.message_id)).toEqual([12, 13]);
  // `^deploy ` (trailing space) anchors to the start AND the word boundary, so
  // it matches "deploy the canary" but not "deployed canary OK".
  expect(searchHistory(sample, '^deploy ', true).map((r) => r.message_id)).toEqual([10]);
});

test('searchHistory: regex is case-insensitive too', () => {
  expect(searchHistory(sample, 'CANARY', true).map((r) => r.message_id)).toEqual([10, 11]);
});

test('searchHistory: invalid regex throws a typed error', () => {
  expect(() => searchHistory(sample, '(', true)).toThrow();
});

test('selectHistory: list, default user direction, scoped to pane %1, oldest→newest, limited', () => {
  // The entrypoint resolves the effective pane (--session / detected / null)
  // and passes it in; here %1 is the resolved scope.
  const out = selectHistory(
    sample,
    {
      kind: 'query',
      direction: 'user',
      action: 'list',
      allSessions: false,
      session: '%1',
      limit: 20,
      full: false,
      json: false,
      regex: false,
    },
    '%1',
  );
  expect(out.map((r) => r.message_id)).toEqual([10]); // only user+%1
});

test('selectHistory: limit keeps the LAST N but renders oldest→newest', () => {
  const many: HistoryRecord[] = [];
  for (let i = 0; i < 10; i++) many.push(R({ ts: 1000 + i, message_id: i, direction: 'user', pane: '%1' }));
  const out = selectHistory(many, {
    kind: 'query',
    direction: 'user',
    action: 'list',
    allSessions: true,
    limit: 3,
    full: false,
    json: false,
    regex: false,
  });
  expect(out.map((r) => r.message_id)).toEqual([7, 8, 9]); // last 3, ascending
});

test('selectHistory: find applies the query after direction + pane scoping', () => {
  const out = selectHistory(sample, {
    kind: 'query',
    direction: 'all',
    action: 'find',
    query: 'canary',
    allSessions: true,
    limit: 20,
    full: false,
    json: false,
    regex: false,
  });
  expect(out.map((r) => r.message_id)).toEqual([10, 11]);
});

test('formatLine: user line shape `[YYYY-MM-DD HH:MM] #id text` with no marker for single-direction', () => {
  const line = formatLine(R({ ts: 1700000000, message_id: 10, text: 'hi', direction: 'user' }), {
    showMarker: false,
    full: false,
    fmtTime: () => '2026-06-15 10:00',
  });
  expect(line).toBe('[2026-06-15 10:00] #10 hi');
});

test('formatLine: null message_id renders #? ', () => {
  const line = formatLine(R({ message_id: null, text: 'hi', direction: 'agent' }), {
    showMarker: false,
    full: false,
    fmtTime: () => '2026-06-15 10:00',
  });
  expect(line).toBe('[2026-06-15 10:00] #? hi');
});

test('formatLine: all-mode prefixes ← for user, → for agent', () => {
  const u = formatLine(R({ message_id: 10, text: 'hi', direction: 'user' }), {
    showMarker: true,
    full: false,
    fmtTime: () => 'T',
  });
  const a = formatLine(R({ message_id: 11, text: 'yo', direction: 'agent' }), {
    showMarker: true,
    full: false,
    fmtTime: () => 'T',
  });
  expect(u).toBe('← [T] #10 hi');
  expect(a).toBe('→ [T] #11 yo');
});

test('formatLine: truncates to ~200 chars unless full', () => {
  const long = 'x'.repeat(500);
  const truncated = formatLine(R({ message_id: 1, text: long, direction: 'user' }), {
    showMarker: false,
    full: false,
    fmtTime: () => 'T',
  });
  // body part after "#1 "
  const body = truncated.split('#1 ')[1];
  expect(body.length).toBe(201); // 200 + ellipsis
  expect(body.endsWith('…')).toBe(true);

  const fullLine = formatLine(R({ message_id: 1, text: long, direction: 'user' }), {
    showMarker: false,
    full: true,
    fmtTime: () => 'T',
  });
  expect(fullLine.split('#1 ')[1].length).toBe(500);
});

test('formatLine: collapses internal newlines to spaces so each record is one line', () => {
  const line = formatLine(R({ message_id: 1, text: 'a\nb\nc', direction: 'user' }), {
    showMarker: false,
    full: false,
    fmtTime: () => 'T',
  });
  expect(line).toBe('[T] #1 a b c');
});

test('formatLines: all-mode shows markers; single-direction omits them', () => {
  const all = formatLines(sample, { direction: 'all', full: false, fmtTime: () => 'T' });
  expect(all[0].startsWith('←')).toBe(true);
  expect(all[1].startsWith('→')).toBe(true);

  const userOnly = formatLines(filterByDirection(sample, 'user'), {
    direction: 'user',
    full: false,
    fmtTime: () => 'T',
  });
  expect(userOnly[0].startsWith('[')).toBe(true);
});

test('buildJsonOutput: machine shape (ts ms, id, direction, from, text, pane)', () => {
  const json = buildJsonOutput([
    R({ ts: 1700000000, message_id: 10, direction: 'user', from: 'Alex', text: 'hi', pane: '%1' }),
  ]);
  expect(json).toEqual([{ ts: 1700000000000, id: 10, direction: 'user', from: 'Alex', text: 'hi', pane: '%1' }]);
});

test('buildJsonOutput: ts is epoch MS (history stores seconds)', () => {
  const json = buildJsonOutput([R({ ts: 1700000000, message_id: 1 })]);
  expect(json[0].ts).toBe(1700000000 * 1000);
});

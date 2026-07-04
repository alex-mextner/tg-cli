import { expect, test } from 'bun:test';
import {
  parseHistory,
  serializeHistoryRecord,
  appendHistory,
  appendRecordsToBlob,
  trimHistoryLines,
  MAX_HISTORY,
  type HistoryRecord,
} from '../features/replies/history';

const rec = (over: Partial<HistoryRecord> = {}): HistoryRecord => ({
  ts: 1000,
  message_id: 1,
  direction: 'user',
  from: 'Alex',
  text: 'hello',
  pane: '%1',
  ...over,
});

test('parseHistory: empty / null → []', () => {
  expect(parseHistory(null)).toEqual([]);
  expect(parseHistory('')).toEqual([]);
  expect(parseHistory('\n\n')).toEqual([]);
});

test('parseHistory: one record per line, tolerates blank + garbage lines', () => {
  const raw = [
    JSON.stringify(rec({ message_id: 1 })),
    '',
    'not json at all',
    '{"ts":2000}', // missing required fields
    JSON.stringify(rec({ message_id: 2, direction: 'agent', from: 'agent' })),
  ].join('\n');
  const out = parseHistory(raw);
  expect(out.length).toBe(2);
  expect(out[0].message_id).toBe(1);
  expect(out[1].message_id).toBe(2);
  expect(out[1].direction).toBe('agent');
});

test('parseHistory: accepts null message_id (outbound with no id)', () => {
  const raw = JSON.stringify(rec({ message_id: null, direction: 'agent' }));
  const out = parseHistory(raw);
  expect(out.length).toBe(1);
  expect(out[0].message_id).toBeNull();
});

test('parseHistory: rejects records with a bad direction', () => {
  const raw = JSON.stringify({ ts: 1, message_id: 1, direction: 'sideways', from: 'x', text: 'y', pane: '%1' });
  expect(parseHistory(raw)).toEqual([]);
});

test('parseHistory: a numeric or empty-string groupId parses as absent, not a group key', () => {
  // The write path (buildOutboundHistoryRecords) only ever emits
  // crypto.randomUUID() or omits the field — a numeric or empty-string
  // groupId can only come from a hand-edited/corrupted line. Treating '' as
  // present would let two DIFFERENT unrelated records with a corrupted
  // `groupId: ''` satisfy select.ts's `prev?.groupId === r.groupId` check
  // and wrongly merge in the plain listing (review: tg-cli#131 follow-up).
  const numeric = JSON.stringify({ ...rec(), groupId: 42 });
  const empty = JSON.stringify({ ...rec(), groupId: '' });
  expect(parseHistory(numeric)[0].groupId).toBeUndefined();
  expect(parseHistory(empty)[0].groupId).toBeUndefined();
});

test('parseHistory: a valid non-empty string groupId round-trips', () => {
  const raw = JSON.stringify({ ...rec(), groupId: 'grp-abc123' });
  expect(parseHistory(raw)[0].groupId).toBe('grp-abc123');
});

test('parseHistory: pane may be null (sent outside tmux)', () => {
  const raw = JSON.stringify(rec({ pane: null, direction: 'agent' }));
  const out = parseHistory(raw);
  expect(out.length).toBe(1);
  expect(out[0].pane).toBeNull();
});

test('serializeHistoryRecord → parse round-trips on a single line (no embedded newline)', () => {
  const r = rec({ text: 'line one\nline two', message_id: 9 });
  const line = serializeHistoryRecord(r);
  expect(line.includes('\n')).toBe(false); // JSON.stringify escapes the newline
  expect(parseHistory(line)).toEqual([r]);
});

test('appendHistory: appends and keeps chronological order', () => {
  let h: HistoryRecord[] = [];
  h = appendHistory(h, rec({ ts: 1, message_id: 1 }));
  h = appendHistory(h, rec({ ts: 2, message_id: 2 }));
  expect(h.map((r) => r.message_id)).toEqual([1, 2]);
});

test('appendHistory: caps to MAX_HISTORY, dropping the oldest', () => {
  let h: HistoryRecord[] = [];
  for (let i = 0; i < MAX_HISTORY + 25; i++) h = appendHistory(h, rec({ ts: i, message_id: i }));
  expect(h.length).toBe(MAX_HISTORY);
  expect(h[0].message_id).toBe(25); // oldest 25 dropped
  expect(h[h.length - 1].message_id).toBe(MAX_HISTORY + 24);
});

test('trimHistoryLines: keeps only the last MAX lines of an on-disk blob', () => {
  const lines: string[] = [];
  for (let i = 0; i < MAX_HISTORY + 10; i++) lines.push(serializeHistoryRecord(rec({ ts: i, message_id: i })));
  const trimmed = trimHistoryLines(lines.join('\n') + '\n', MAX_HISTORY);
  const parsed = parseHistory(trimmed);
  expect(parsed.length).toBe(MAX_HISTORY);
  expect(parsed[0].message_id).toBe(10);
});

test('trimHistoryLines: short blob is returned unchanged (still ends with newline)', () => {
  const blob = serializeHistoryRecord(rec()) + '\n';
  expect(trimHistoryLines(blob, MAX_HISTORY)).toBe(blob);
});

test('trimHistoryLines: drops blank trailing lines from the count but preserves data lines', () => {
  const a = serializeHistoryRecord(rec({ message_id: 1 }));
  const b = serializeHistoryRecord(rec({ message_id: 2 }));
  const trimmed = trimHistoryLines(`${a}\n${b}\n\n`, 5);
  expect(parseHistory(trimmed).map((r) => r.message_id)).toEqual([1, 2]);
});

test('appendRecordsToBlob: appends new records to an existing blob, trimmed to bound', () => {
  const existing = serializeHistoryRecord(rec({ message_id: 1 })) + '\n';
  const out = appendRecordsToBlob(existing, [rec({ message_id: 2 }), rec({ message_id: 3 })], MAX_HISTORY);
  expect(parseHistory(out).map((r) => r.message_id)).toEqual([1, 2, 3]);
  expect(out.endsWith('\n')).toBe(true);
});

test('appendRecordsToBlob: null/empty existing blob starts fresh', () => {
  const out = appendRecordsToBlob(null, [rec({ message_id: 7 })], MAX_HISTORY);
  expect(parseHistory(out).map((r) => r.message_id)).toEqual([7]);
});

test('appendRecordsToBlob: enforces the bound when existing + new exceed it', () => {
  const lines: string[] = [];
  for (let i = 0; i < MAX_HISTORY; i++) lines.push(serializeHistoryRecord(rec({ ts: i, message_id: i })));
  const existing = lines.join('\n') + '\n';
  const out = appendRecordsToBlob(existing, [rec({ ts: 99999, message_id: 99999 })], MAX_HISTORY);
  const parsed = parseHistory(out);
  expect(parsed.length).toBe(MAX_HISTORY);
  expect(parsed[parsed.length - 1].message_id).toBe(99999);
  expect(parsed[0].message_id).toBe(1); // the very oldest (id 0) was dropped
});

test('appendRecordsToBlob: appending nothing leaves the blob normalized but intact', () => {
  const existing = serializeHistoryRecord(rec({ message_id: 1 })) + '\n';
  expect(parseHistory(appendRecordsToBlob(existing, [], MAX_HISTORY)).map((r) => r.message_id)).toEqual([1]);
});

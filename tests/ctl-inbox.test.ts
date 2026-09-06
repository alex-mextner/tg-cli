import { expect, test } from 'bun:test';
import { idsToAck, inboxDirFor, inboxRoot, isDeliveredBatchFile, parseInboxLines, serializeInboxEntry } from '../features/tg-ctl/inbox';

test('inbox paths live under <configDir>/inbox/<key>', () => {
  expect(inboxRoot('/cfg')).toBe('/cfg/inbox');
  expect(inboxDirFor('/cfg', 'landing')).toBe('/cfg/inbox/landing');
});

test('serializeInboxEntry is one newline-terminated JSON line (newlines escaped)', () => {
  const line = serializeInboxEntry({ id: 42, ts: '2026-09-06T00:00:00Z', from: 'Alex', text: 'a\nb', wrapped: '[TG from Alex tg#42] a\nb' });
  expect(line.endsWith('\n')).toBe(true);
  expect(line.slice(0, -1)).not.toContain('\n');
  expect(JSON.parse(line)).toMatchObject({ id: 42, text: 'a\nb' });
});

test('parseInboxLines is lenient: malformed lines are counted, good ones kept', () => {
  const text = '{"id":1,"ts":"t","from":"a","text":"x","wrapped":"w1"}\nnot json\n{"nope":true}\n\n{"id":null,"ts":"t","from":"a","text":"y","wrapped":"w2"}\n';
  const r = parseInboxLines(text);
  expect(r.entries.map((e) => e.wrapped)).toEqual(['w1', 'w2']);
  expect(r.malformed).toBe(2);
});

test('idsToAck keeps integer ids once, skips null/malformed', () => {
  const ids = idsToAck([
    { id: 5, ts: 't', from: 'a', text: 'x', wrapped: 'w' },
    { id: 5, ts: 't', from: 'a', text: 'x', wrapped: 'w' },
    { id: null, ts: 't', from: 'a', text: 'x', wrapped: 'w' },
    { id: 6, ts: 't', from: 'a', text: 'x', wrapped: 'w', malformed: true },
    { id: 7, ts: 't', from: 'a', text: 'x', wrapped: 'w' },
  ]);
  expect(ids).toEqual([5, 7]);
});

test('isDeliveredBatchFile: only complete delivered-*.jsonl batches, never the temp file', () => {
  expect(isDeliveredBatchFile('delivered-77-1757000000000000000-ab12cd34.jsonl')).toBe(true);
  expect(isDeliveredBatchFile('delivered-77-1757000000000000000-ab12cd34.jsonl.tmp')).toBe(false);
  expect(isDeliveredBatchFile('pending.jsonl')).toBe(false);
  expect(isDeliveredBatchFile('acked.jsonl')).toBe(false);
});

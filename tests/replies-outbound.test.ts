import { expect, test } from 'bun:test';
import { buildOutboundHistoryRecords, outboundHistoryText } from '../features/replies/outbound';

test('outboundHistoryText: prefers the message body', () => {
  expect(outboundHistoryText('done, shipped #42', { photos: 0, documents: 0 })).toBe('done, shipped #42');
});

test('outboundHistoryText: empty body + a photo → [photo] placeholder', () => {
  expect(outboundHistoryText('', { photos: 1, documents: 0 })).toBe('[photo]');
});

test('outboundHistoryText: empty body + multiple photos → [N photos]', () => {
  expect(outboundHistoryText('   ', { photos: 3, documents: 0 })).toBe('[3 photos]');
});

test('outboundHistoryText: empty body + a document → [document]', () => {
  expect(outboundHistoryText('', { photos: 0, documents: 1 })).toBe('[document]');
});

test('outboundHistoryText: empty body + multiple documents → [N files]', () => {
  expect(outboundHistoryText('', { photos: 0, documents: 2 })).toBe('[2 files]');
});

test('outboundHistoryText: a caption WITH attachments keeps the caption', () => {
  expect(outboundHistoryText('see attached', { photos: 1, documents: 0 })).toBe('see attached');
});

// Regression: buildOutboundHistoryRecords now writes one record per outbound
// id, including document ids — a photos-only placeholder would mislabel a
// mixed-media send's document records as "[N photos]" (review: tg-cli#131).
test('outboundHistoryText: empty body + mixed photos AND documents → combined placeholder', () => {
  expect(outboundHistoryText('', { photos: 1, documents: 1 })).toBe('[photo, document]');
  expect(outboundHistoryText('', { photos: 2, documents: 3 })).toBe('[2 photos, 3 files]');
});

test('outboundHistoryText: nothing at all → null (nothing worth logging)', () => {
  expect(outboundHistoryText('', { photos: 0, documents: 0 })).toBeNull();
  expect(outboundHistoryText('   ', { photos: 0, documents: 0 })).toBeNull();
});

// buildOutboundHistoryRecords: one `agent` history record PER outbound
// Telegram message_id, so a reply anchored to ANY chunk of a split send or
// ANY item of a media-group album stays recall-able via `tg replies --json |
// select(.id == <tg#>)` — not just the first (review: tg-cli#131).

test('buildOutboundHistoryRecords: a single outbound id → one record', () => {
  const recs = buildOutboundHistoryRecords([501], 'deployed', 1700000000, '%1');
  expect(recs).toEqual([
    { ts: 1700000000, message_id: 501, direction: 'agent', from: 'agent', text: 'deployed', pane: '%1' },
  ]);
});

test('buildOutboundHistoryRecords: a >4096 split emits one record per chunk id, same text', () => {
  const recs = buildOutboundHistoryRecords([201, 202, 203], 'long report', 1700000000, '%1');
  expect(recs.map((r) => r.message_id)).toEqual([201, 202, 203]);
  expect(recs.every((r) => r.text === 'long report')).toBe(true);
  expect(recs.every((r) => r.ts === 1700000000 && r.direction === 'agent' && r.pane === '%1')).toBe(true);
});

test('buildOutboundHistoryRecords: a media-group album — reply to a NON-FIRST item is recall-able', () => {
  // Regression for tg-cli#131: previously only `firstOutboundId` (301) was
  // recorded, so a reply anchored to the album's 2nd/3rd item (302, 303) had
  // no matching history record. Now every item id gets its own record.
  const recs = buildOutboundHistoryRecords([301, 302, 303], '[3 photos]', 1700000000, '%2');
  const byId = new Map(recs.map((r) => [r.message_id, r]));
  expect(byId.get(301)?.text).toBe('[3 photos]');
  expect(byId.get(302)?.text).toBe('[3 photos]'); // 2nd album item — the reported bug case
  expect(byId.get(303)?.text).toBe('[3 photos]');
});

test('buildOutboundHistoryRecords: no outbound ids at all → single record with message_id null (unchanged fallback)', () => {
  const recs = buildOutboundHistoryRecords([], 'sent outside tmux', 1700000000, '%1');
  expect(recs).toEqual([
    { ts: 1700000000, message_id: null, direction: 'agent', from: 'agent', text: 'sent outside tmux', pane: '%1' },
  ]);
});

// If a caller ever reports the same message_id twice (e.g. a retry), dedupe
// rather than double-log — matches routes.ts's own dedupe-by-id (appendRoute).
test('buildOutboundHistoryRecords: a duplicated id collapses to one record', () => {
  const recs = buildOutboundHistoryRecords([501, 501, 502], 'deployed', 1700000000, '%1');
  expect(recs.map((r) => r.message_id)).toEqual([501, 502]);
});

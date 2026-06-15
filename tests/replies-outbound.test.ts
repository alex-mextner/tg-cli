import { expect, test } from 'bun:test';
import { outboundHistoryText } from '../features/replies/outbound';

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

test('outboundHistoryText: nothing at all → null (nothing worth logging)', () => {
  expect(outboundHistoryText('', { photos: 0, documents: 0 })).toBeNull();
  expect(outboundHistoryText('   ', { photos: 0, documents: 0 })).toBeNull();
});

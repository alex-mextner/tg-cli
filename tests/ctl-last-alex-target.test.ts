import { expect, test } from 'bun:test';
import { parseLastAlexTarget, serializeLastAlexTarget } from '../features/tg-ctl/last-alex-target';

// tg-cli#78 anchor fix: pure serialization tests for the store's parse/write
// contract. Integration coverage (the daemon actually recording/resolving
// against this store) lives in ctl-ambiguous-picker-integration.test.ts and
// ctl-reply-misroute-integration.test.ts.

test('parseLastAlexTarget: null raw → null', () => {
  expect(parseLastAlexTarget(null)).toBeNull();
});

test('parseLastAlexTarget: empty string → null', () => {
  expect(parseLastAlexTarget('')).toBeNull();
});

test('parseLastAlexTarget: malformed JSON → null (never throws)', () => {
  expect(parseLastAlexTarget('{not valid json')).toBeNull();
});

test('parseLastAlexTarget: JSON that is not an object → null', () => {
  expect(parseLastAlexTarget('42')).toBeNull();
  expect(parseLastAlexTarget('"a string"')).toBeNull();
  expect(parseLastAlexTarget('[1,2,3]')).toBeNull();
  expect(parseLastAlexTarget('null')).toBeNull();
});

test('parseLastAlexTarget: missing paneId → null', () => {
  expect(parseLastAlexTarget(JSON.stringify({ ts: 100 }))).toBeNull();
});

test('parseLastAlexTarget: non-string paneId → null', () => {
  expect(parseLastAlexTarget(JSON.stringify({ paneId: 5, ts: 100 }))).toBeNull();
});

test('parseLastAlexTarget: missing ts → null', () => {
  expect(parseLastAlexTarget(JSON.stringify({ paneId: '%5', cwd: '/x' }))).toBeNull();
});

test('parseLastAlexTarget: missing cwd → null (required, not optional — invalid states are not representable)', () => {
  expect(parseLastAlexTarget(JSON.stringify({ paneId: '%5', ts: 100 }))).toBeNull();
});

test('parseLastAlexTarget: non-string cwd → null', () => {
  expect(parseLastAlexTarget(JSON.stringify({ paneId: '%5', cwd: 42, ts: 100 }))).toBeNull();
});

test('parseLastAlexTarget: empty-string cwd → null (not just wrong type — review finding)', () => {
  expect(parseLastAlexTarget(JSON.stringify({ paneId: '%5', cwd: '', ts: 100 }))).toBeNull();
});

test('parseLastAlexTarget: empty-string paneId → null', () => {
  expect(parseLastAlexTarget(JSON.stringify({ paneId: '', cwd: '/x', ts: 100 }))).toBeNull();
});

test('parseLastAlexTarget: non-number ts → null', () => {
  expect(parseLastAlexTarget(JSON.stringify({ paneId: '%5', ts: 'now' }))).toBeNull();
});

test('parseLastAlexTarget: non-finite ts (NaN/Infinity) → null', () => {
  // NaN isn't valid JSON (JSON.parse throws, caught before Number.isFinite runs)
  // and JSON.stringify({ts: Infinity}) serializes ts as `null` (rejected by the
  // `typeof rec.ts !== 'number'` check, not isFinite) — both inputs are also
  // missing `cwd`, so all three cases reject for reasons OTHER than the
  // !Number.isFinite branch itself. Kept as documentation of those paths.
  expect(parseLastAlexTarget('{"paneId":"%5","ts":NaN}')).toBeNull();
  expect(parseLastAlexTarget(JSON.stringify({ paneId: '%5', ts: Infinity }))).toBeNull();
});

test('parseLastAlexTarget: ts that overflows to Infinity via valid JSON → null (actually exercises !Number.isFinite, review finding)', () => {
  // `1e999` IS valid JSON syntax that parses to the JS value Infinity — unlike
  // the literal `Infinity`/`NaN` tokens above (invalid JSON) or a stringified
  // Infinity (which serializes to `null`), this is the one input that actually
  // reaches and is rejected by the `!Number.isFinite(rec.ts)` branch.
  expect(parseLastAlexTarget('{"paneId":"%5","cwd":"/x","ts":1e999}')).toBeNull();
});

test('parseLastAlexTarget: valid record round-trips', () => {
  const target = { paneId: '%5', cwd: '/Users/x/proj', ts: 12345 };
  expect(parseLastAlexTarget(serializeLastAlexTarget(target))).toEqual(target);
});

test('serializeLastAlexTarget: produces valid JSON parseable by parseLastAlexTarget', () => {
  const target = { paneId: '%2', cwd: '/Users/x/proj', ts: 999 };
  const raw = serializeLastAlexTarget(target);
  expect(() => JSON.parse(raw)).not.toThrow();
  expect(parseLastAlexTarget(raw)).toEqual(target);
});

import { expect, test } from 'bun:test';
import { CACHE_TTL_MS, mergeIntoCache, splitByCache } from '../features/autolink-tasks/cache';
import type { TicketInfo } from '../features/autolink-tasks/linear';

const T0 = 1_750_000_000_000; // fixed epoch ms for determinism

const info = (code: string): TicketInfo => ({
  code,
  title: `Title ${code}`,
  url: `https://linear.app/x/issue/${code}/slug`,
});

const rawWith = (entries: Record<string, { t: number; info: TicketInfo | null }>): string =>
  JSON.stringify({ entries });

// --- splitByCache ---

test('split: fresh positive entry is a hit', () => {
  const raw = rawWith({ 'HYP-1': { t: T0 - 1000, info: info('HYP-1') } });
  const { hits, missing } = splitByCache(['HYP-1'], raw, T0);
  expect(hits.get('HYP-1')?.title).toBe('Title HYP-1');
  expect(missing).toEqual([]);
});

test('split: fresh negative entry is a hit (verified-absent)', () => {
  const raw = rawWith({ 'XXX-9': { t: T0 - 1000, info: null } });
  const { hits, missing } = splitByCache(['XXX-9'], raw, T0);
  expect(hits.has('XXX-9')).toBe(true);
  expect(hits.get('XXX-9')).toBeNull();
  expect(missing).toEqual([]);
});

test('split: expired entry is missing', () => {
  const raw = rawWith({ 'HYP-1': { t: T0 - CACHE_TTL_MS - 1, info: info('HYP-1') } });
  const { hits, missing } = splitByCache(['HYP-1'], raw, T0);
  expect(hits.size).toBe(0);
  expect(missing).toEqual(['HYP-1']);
});

test('split: entry at exactly TTL boundary is expired', () => {
  const raw = rawWith({ 'HYP-1': { t: T0 - CACHE_TTL_MS, info: info('HYP-1') } });
  const { missing } = splitByCache(['HYP-1'], raw, T0);
  expect(missing).toEqual(['HYP-1']);
});

test('split: null / corrupt / non-object raw → everything missing', () => {
  for (const raw of [null, 'garbage', '[1]', '{"entries":"nope"}']) {
    const { hits, missing } = splitByCache(['HYP-1', 'ABC-2'], raw, T0);
    expect(hits.size).toBe(0);
    expect(missing).toEqual(['HYP-1', 'ABC-2']);
  }
});

test('split: mixed hits preserve order of missing codes', () => {
  const raw = rawWith({ 'HYP-2': { t: T0 - 1, info: info('HYP-2') } });
  const { hits, missing } = splitByCache(['HYP-1', 'HYP-2', 'HYP-3'], raw, T0);
  expect(hits.size).toBe(1);
  expect(missing).toEqual(['HYP-1', 'HYP-3']);
});

// --- mergeIntoCache ---

test('merge: probed codes get positive entries, absent ones negative', () => {
  const tickets = new Map([['HYP-1', info('HYP-1')]]);
  const raw = mergeIntoCache(null, ['HYP-1', 'XXX-9'], tickets, T0);
  const { hits, missing } = splitByCache(['HYP-1', 'XXX-9'], raw, T0 + 1000);
  expect(hits.get('HYP-1')?.url).toContain('HYP-1');
  expect(hits.get('XXX-9')).toBeNull();
  expect(missing).toEqual([]);
});

test('merge: keeps fresh unrelated entries, prunes expired ones', () => {
  const old = rawWith({
    'OLD-1': { t: T0 - CACHE_TTL_MS - 5000, info: info('OLD-1') },
    'KEEP-2': { t: T0 - 1000, info: info('KEEP-2') },
  });
  const raw = mergeIntoCache(old, ['HYP-1'], new Map([['HYP-1', info('HYP-1')]]), T0);
  const parsed = JSON.parse(raw) as { entries: Record<string, unknown> };
  expect(Object.keys(parsed.entries).sort()).toEqual(['HYP-1', 'KEEP-2']);
});

test('merge: corrupt old raw is treated as empty', () => {
  const raw = mergeIntoCache('not json', ['HYP-1'], new Map(), T0);
  const { hits } = splitByCache(['HYP-1'], raw, T0 + 1);
  expect(hits.get('HYP-1')).toBeNull();
});

test('merge → split roundtrip respects TTL', () => {
  const raw = mergeIntoCache(null, ['HYP-1'], new Map([['HYP-1', info('HYP-1')]]), T0);
  expect(splitByCache(['HYP-1'], raw, T0 + CACHE_TTL_MS - 1).missing).toEqual([]);
  expect(splitByCache(['HYP-1'], raw, T0 + CACHE_TTL_MS).missing).toEqual(['HYP-1']);
});

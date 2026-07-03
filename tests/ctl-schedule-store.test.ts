import { expect, test } from 'bun:test';
import {
  isDeadReset,
  parseSchedules,
  removeSchedule,
  serializeSchedules,
  upsertSchedule,
  type AutoContinueSchedule,
} from '../features/tg-ctl/schedule-store';

const NOW = 1_720_000_000_000;

const sched = (over: Partial<AutoContinueSchedule> = {}): AutoContinueSchedule => ({
  paneId: '%3',
  resetAt: NOW + 3_600_000,
  agent: 'hyperide',
  sourceMessageId: 42,
  cardMessageId: 77,
  armedAt: NOW,
  ...over,
});

test('round-trips a valid schedule', () => {
  const blob = serializeSchedules({ schedules: [sched()] }, NOW);
  expect(parseSchedules(blob, NOW).schedules).toEqual([sched()]);
});

test('parse: malformed / absent / non-array → empty', () => {
  expect(parseSchedules(null, NOW).schedules).toEqual([]);
  expect(parseSchedules('not json', NOW).schedules).toEqual([]);
  expect(parseSchedules('{"schedules":"x"}', NOW).schedules).toEqual([]);
});

test('parse: drops invalid records but keeps valid ones', () => {
  const blob = JSON.stringify({ schedules: [sched(), { paneId: 5, resetAt: 'x' }, { junk: true }] });
  expect(parseSchedules(blob, NOW).schedules).toHaveLength(1);
});

// Review round 2 (Opus, PR #120): isDeadReset now treats a non-finite resetAt
// as dead, which flips prune()'s prior verdict for +Infinity specifically
// (old `resetAt >= now - DEAD` was true for Infinity → kept; now dropped).
// Confirms that edge never reaches prune() via the persisted-disk path: JSON
// has no Infinity literal (JSON.stringify(Infinity) → `null`), and isValid's
// `Number.isFinite` gate already rejects a null/non-numeric resetAt before
// prune ever runs — so the flip is unreachable through parseSchedules, not a
// real regression for any record that ever touched disk.
test('parse: a JSON-null resetAt (Infinity\'s only possible on-disk form) is invalid, dropped before prune', () => {
  const blob = JSON.stringify({ schedules: [sched(), { ...sched({ paneId: '%9' }), resetAt: null }] });
  expect(parseSchedules(blob, NOW).schedules.map((s) => s.paneId)).toEqual(['%3']);
});

test('prune: a reset more than a day in the past is dead and dropped', () => {
  const dead = sched({ resetAt: NOW - 25 * 60 * 60 * 1000 });
  const recent = sched({ paneId: '%9', resetAt: NOW - 60_000 }); // recently past → still re-armable
  const out = parseSchedules(JSON.stringify({ schedules: [dead, recent] }), NOW).schedules;
  expect(out.map((s) => s.paneId)).toEqual(['%9']);
});

test('upsert: one pending continue per pane (a new tap replaces the old)', () => {
  let data = { schedules: [sched({ resetAt: NOW + 1000 })] };
  data = upsertSchedule(data, sched({ resetAt: NOW + 9999 }));
  expect(data.schedules).toHaveLength(1);
  expect(data.schedules[0].resetAt).toBe(NOW + 9999);
  data = upsertSchedule(data, sched({ paneId: '%7' }));
  expect(data.schedules).toHaveLength(2);
});

test('remove: drops the pane, leaves others', () => {
  const data = { schedules: [sched(), sched({ paneId: '%7' })] };
  expect(removeSchedule(data, '%3').schedules.map((s) => s.paneId)).toEqual(['%7']);
});

// PR #120 review: exported so the entrypoint can reject a stale FIRST-TIME
// button tap with the identical threshold `prune` already applies on restart.
test('isDeadReset: matches the exact `prune` threshold (more than a day past → dead)', () => {
  expect(isDeadReset(NOW - 25 * 60 * 60 * 1000, NOW)).toBe(true);
  expect(isDeadReset(NOW - 60_000, NOW)).toBe(false); // recently past → still re-armable
  expect(isDeadReset(NOW + 3_600_000, NOW)).toBe(false); // future
});

// Review round 2 (Opus, PR #120): `NaN < x` is always false, so a naive
// `resetAt < now - DEAD_AFTER_MS` check would let a non-finite resetAt slip
// PAST the guard instead of being rejected by it — exactly backwards for a
// guard whose whole job is refusing an untrustworthy reset time.
test('isDeadReset: a non-finite resetAt (NaN/Infinity) counts as dead, never bypasses the guard', () => {
  expect(isDeadReset(NaN, NOW)).toBe(true);
  expect(isDeadReset(Infinity, NOW)).toBe(true);
  expect(isDeadReset(-Infinity, NOW)).toBe(true);
});

import { expect, test } from 'bun:test';
import {
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

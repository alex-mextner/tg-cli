// Tests for the pure usage-schedule policy (features/tg-ctl/usage-schedule.ts) — the
// end-of-week/end-of-month calendar logic and the launchd plist/plan builders for the
// scheduled `/usage` push. Pure — no real launchd, no I/O, no clock dependency (dates are
// passed in explicitly).
import { expect, test } from 'bun:test';
import {
  EMPTY_USAGE_SCHEDULE_WATERMARK,
  USAGE_SCHEDULE_LAUNCHD_LABEL,
  buildUsageScheduleDisablePlan,
  buildUsageScheduleEnablePlan,
  completedMonthId,
  completedWeekId,
  isEndOfMonth,
  isEndOfWeek,
  missedUsageReportNotice,
  parseUsageScheduleWatermark,
  seedUsageScheduleWatermarkFor,
  shouldSeedUsageScheduleWatermark,
  usageScheduleGapNote,
  USAGE_SCHEDULE_FIRE_HOUR,
  USAGE_SCHEDULE_FIRE_MINUTE,
  usageScheduleLaunchdPlist,
  usageScheduleLaunchdPlistPath,
  usageSchedulePeriodsDue,
  type UsageScheduleEnv,
} from '../features/tg-ctl/usage-schedule';

function env(overrides: Partial<UsageScheduleEnv> = {}): UsageScheduleEnv {
  return {
    home: '/home/u',
    binPath: '/home/u/.files/bin/tg-ctl',
    bunPath: '/home/u/.bun/bin/bun',
    logPath: '/home/u/.config/tg-cli/tg-ctl.123456.log',
    // Default config dir — matches autostart.ts's defaultConfigDir('/home/u'), so by default
    // no TG_CTL_CONFIG_DIR pin is expected (mirrors the daemon's own autostart plist policy).
    configDir: '/home/u/.config/tg-cli',
    pathEnv: '/home/u/.files/bin:/opt/homebrew/bin:/usr/bin:/bin',
    ...overrides,
  };
}

test('isEndOfWeek: true only on Sunday', () => {
  // 2026-08-30 is a real Sunday (Alex's own machine date at the time this was written).
  expect(isEndOfWeek(new Date(2026, 7, 30))).toBe(true); // Sun
  expect(isEndOfWeek(new Date(2026, 7, 29))).toBe(false); // Sat
  expect(isEndOfWeek(new Date(2026, 7, 24))).toBe(false); // Mon
});

test('isEndOfMonth: true on the last calendar day, including short/leap Februaries', () => {
  expect(isEndOfMonth(new Date(2026, 7, 31))).toBe(true); // Aug 31
  expect(isEndOfMonth(new Date(2026, 7, 30))).toBe(false); // Aug 30
  expect(isEndOfMonth(new Date(2026, 3, 30))).toBe(true); // Apr 30 (30-day month)
  expect(isEndOfMonth(new Date(2026, 3, 29))).toBe(false);
  expect(isEndOfMonth(new Date(2026, 1, 28))).toBe(true); // 2026 is not a leap year: Feb 28
  expect(isEndOfMonth(new Date(2024, 1, 29))).toBe(true); // 2024 IS a leap year: Feb 29
  expect(isEndOfMonth(new Date(2024, 1, 28))).toBe(false);
});

test('a day can be both end-of-week and end-of-month at once', () => {
  // 2026-05-31 is a real Sunday that also happens to be May's last day — confirmed both
  // conditions can be simultaneously true (the scheduled job sends BOTH reports that day).
  const bothTrue = new Date(2026, 4, 31);
  expect(bothTrue.getDay()).toBe(0); // sanity: really is a Sunday
  expect(isEndOfWeek(bothTrue)).toBe(true);
  expect(isEndOfMonth(bothTrue)).toBe(true);
});

test('usageScheduleLaunchdPlistPath: ~/Library/LaunchAgents/<label>.plist', () => {
  expect(usageScheduleLaunchdPlistPath('/home/u')).toBe(`/home/u/Library/LaunchAgents/${USAGE_SCHEDULE_LAUNCHD_LABEL}.plist`);
});

test('usageScheduleLaunchdPlist: fires daily at 23:50, no RunAtLoad, runs usage-schedule-check', () => {
  const xml = usageScheduleLaunchdPlist(env());
  expect(xml).toContain(`<string>${USAGE_SCHEDULE_LAUNCHD_LABEL}</string>`);
  expect(xml).toContain('<string>/home/u/.bun/bin/bun</string>');
  expect(xml).toContain('<string>/home/u/.files/bin/tg-ctl</string>');
  expect(xml).toContain('<string>usage-schedule-check</string>');
  expect(xml).toContain('<key>StartCalendarInterval</key>');
  expect(xml).toContain('<key>Hour</key>\n\t\t<integer>23</integer>');
  expect(xml).toContain('<key>Minute</key>\n\t\t<integer>50</integer>');
  // Deliberately NOT RunAtLoad — this job should only fire on its calendar schedule, not at
  // every install/login (unlike the daemon's own autostart plist).
  expect(xml).not.toContain('RunAtLoad');
  expect(xml).toContain('/home/u/.config/tg-cli/tg-ctl.123456.log');
});

test('usageScheduleLaunchdPlist XML-escapes an unusual path', () => {
  const xml = usageScheduleLaunchdPlist(env({ binPath: '/home/u & co/tg-ctl' }));
  expect(xml).toContain('/home/u &amp; co/tg-ctl');
  expect(xml).not.toContain('/home/u & co/tg-ctl');
});

// PATH must always be pinned: launchd starts this job with a minimal PATH that does not
// include wherever `tg`/`rig` are actually installed (~/.files/bin, ~/.local/bin, Homebrew,
// npm global, …), so `runUsageScheduleCheck`'s bare `spawnGuarded(["tg", …])` / `["rig", …]`
// calls would otherwise fail to resolve at 23:50 with no visible error to the user.
test('usageScheduleLaunchdPlist always pins PATH from the enabling shell', () => {
  const xml = usageScheduleLaunchdPlist(env());
  expect(xml).toContain('<key>EnvironmentVariables</key>');
  expect(xml).toContain('<key>PATH</key>');
  expect(xml).toContain('<string>/home/u/.files/bin:/opt/homebrew/bin:/usr/bin:/bin</string>');
});

// The daemon launches with a minimal env that does NOT inherit $TG_CTL_CONFIG_DIR (same
// reasoning as autostart.ts's autostartUnitEnv for the main daemon plist) — a non-default
// config dir must be pinned or the scheduled check silently falls back to ~/.config/tg-cli
// and can't find the credentials it was enabled with.
test('usageScheduleLaunchdPlist pins TG_CTL_CONFIG_DIR only for a non-default config dir', () => {
  const defaultXml = usageScheduleLaunchdPlist(env());
  expect(defaultXml).not.toContain('TG_CTL_CONFIG_DIR');

  const customXml = usageScheduleLaunchdPlist(env({ configDir: '/home/u/.config/tg-cli-work' }));
  expect(customXml).toContain('<key>TG_CTL_CONFIG_DIR</key>');
  expect(customXml).toContain('<string>/home/u/.config/tg-cli-work</string>');
});

test('buildUsageScheduleEnablePlan: unload-then-load, file mode 0o644', () => {
  const plan = buildUsageScheduleEnablePlan(env());
  expect(plan.file.path).toBe(usageScheduleLaunchdPlistPath('/home/u'));
  expect(plan.file.mode).toBe(0o644);
  expect(plan.commands.map((c) => c.argv)).toEqual([
    ['launchctl', 'unload', plan.file.path],
    ['launchctl', 'load', plan.file.path],
  ]);
  expect(plan.commands[0].optional).toBe(true);
  expect(plan.commands[1].optional).toBeUndefined();
});

test('buildUsageScheduleDisablePlan: single unload command gates file removal', () => {
  const plan = buildUsageScheduleDisablePlan('/home/u');
  expect(plan.filePath).toBe(usageScheduleLaunchdPlistPath('/home/u'));
  // `optional`: a plist left on disk by a half-failed enable (load failed) was never loaded, so
  // its unload exits non-zero — disable must still go on to delete the file (review finding).
  expect(plan.commands).toEqual([
    { argv: ['launchctl', 'unload', plan.filePath], describe: 'unload the usage-schedule LaunchAgent (stops it)', optional: true },
  ]);
});

test('completedWeekId: mid-week resolves to the PRIOR Sunday (this week has not completed yet)', () => {
  // Mon 2026-08-24 through Sat 2026-08-29 are still an in-progress week — the most recently
  // COMPLETED week ended on the Sunday before, 2026-08-23.
  expect(completedWeekId(new Date(2026, 7, 24))).toBe('2026-08-23'); // Mon
  expect(completedWeekId(new Date(2026, 7, 26))).toBe('2026-08-23'); // Wed
  // On Sunday itself, that week is currently completing — it resolves to itself.
  expect(completedWeekId(new Date(2026, 7, 30))).toBe('2026-08-30');
  // The Monday right after still resolves to the Sunday that JUST completed, not itself.
  expect(completedWeekId(new Date(2026, 7, 31))).toBe('2026-08-30');
});

test('completedWeekId: a Sunday in the first days of January resolves across the year boundary', () => {
  // Fri 2027-01-01: the last completed week ended Sun 2026-12-27 — the literal-Sunday id
  // has no ISO week-number ambiguity to trip over.
  expect(completedWeekId(new Date(2027, 0, 1))).toBe('2026-12-27');
});

test('completedMonthId: before month-end resolves to the PRIOR month (this month has not completed yet)', () => {
  expect(completedMonthId(new Date(2026, 7, 1))).toBe('2026-07'); // Aug 1: August isn't done — July is the last completed month
  expect(completedMonthId(new Date(2026, 7, 15))).toBe('2026-07');
  expect(completedMonthId(new Date(2026, 7, 31))).toBe('2026-08'); // last day: August is currently completing
  expect(completedMonthId(new Date(2026, 8, 1))).toBe('2026-08'); // Sep 1: August just completed
  expect(completedMonthId(new Date(2027, 0, 1))).toBe('2026-12'); // Jan 1: December of the prior year
});

// launchd fires at 23:50 — every "on time" fixture below uses that instant so it doesn't
// trip the boundary-day-hasn't-closed-yet gate (see periodHasClosed / review finding).
const atFireTime = (y: number, m: number, d: number) => new Date(y, m, d, USAGE_SCHEDULE_FIRE_HOUR, USAGE_SCHEDULE_FIRE_MINUTE);

test('usageSchedulePeriodsDue: both due on a fresh (null watermark) run, checked AT the fire time; week on time on a Sunday, month not', () => {
  const due = usageSchedulePeriodsDue(atFireTime(2026, 7, 30), EMPTY_USAGE_SCHEDULE_WATERMARK); // Sunday Aug 30, 23:50
  expect(due.map((d) => d.period).sort()).toEqual(['month', 'week']);
  expect(due.find((d) => d.period === 'week')).toMatchObject({ id: '2026-08-30', onTime: true, hasGap: false });
  expect(due.find((d) => d.period === 'month')).toMatchObject({ id: '2026-07', onTime: false, hasGap: false });
});

test('usageSchedulePeriodsDue: a boundary day BEFORE the fire time is NOT due yet — no premature partial report (review HIGH finding)', () => {
  // Sunday Aug 30, 09:00 — the week hasn't actually finished; a run this early (a wake from
  // a missed EARLIER firing, a hand-run, or any trigger before 23:50) must not send a report
  // covering only part of the day, nor claim the day was "missed" — tonight's real 23:50
  // firing still covers it normally.
  const earlyOnBoundaryDay = new Date(2026, 7, 30, 9, 0);
  const due = usageSchedulePeriodsDue(earlyOnBoundaryDay, EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(due.find((d) => d.period === 'week')).toBeUndefined();
});

test('usageSchedulePeriodsDue: the fire minute itself is on time; one minute earlier is not', () => {
  const dueAt = usageSchedulePeriodsDue(new Date(2026, 7, 30, 23, 50), EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(dueAt.find((d) => d.period === 'week')).toMatchObject({ onTime: true, hasGap: false });
  const dueBefore = usageSchedulePeriodsDue(new Date(2026, 7, 30, 23, 49), EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(dueBefore.find((d) => d.period === 'week')).toBeUndefined();
});

test('usageSchedulePeriodsDue: a NON-boundary day is never gated by time of day (only a boundary day can be "not closed yet")', () => {
  const midWeekMidnight = usageSchedulePeriodsDue(new Date(2026, 7, 24), { lastWeekReported: '2026-08-16', lastMonthReported: '2026-07' }); // Monday 00:00
  // '2026-08-16' IS the week immediately before '2026-08-23' — adjacent, no gap.
  expect(midWeekMidnight.find((d) => d.period === 'week')).toMatchObject({ id: '2026-08-23', onTime: false, hasGap: false });
});

test('usageSchedulePeriodsDue: neither due once both watermarks match the current period', () => {
  const now = new Date(2026, 7, 24); // mid-August, mid-week
  const watermark = { lastWeekReported: completedWeekId(now), lastMonthReported: completedMonthId(now) };
  expect(usageSchedulePeriodsDue(now, watermark)).toEqual([]);
});

test('usageSchedulePeriodsDue: a watermark already matching TODAY\'s in-progress boundary period is not re-marked due before the fire time', () => {
  // Guards against a regression where the "not closed yet" gate is bypassed for a period
  // whose id already happens to equal today's (there is no such period pre-fire-time, but
  // the watermark equality check must still short-circuit correctly either way).
  const earlyOnBoundaryDay = new Date(2026, 7, 30, 9, 0); // Sunday, before 23:50
  const watermark = { lastWeekReported: completedWeekId(earlyOnBoundaryDay), lastMonthReported: null };
  expect(usageSchedulePeriodsDue(earlyOnBoundaryDay, watermark).find((d) => d.period === 'week')).toBeUndefined();
});

test('usageSchedulePeriodsDue: a week missed while the machine was asleep is still surfaced on the next run — as LATE', () => {
  // Watermark still points at the PRIOR week (the machine slept through last Sunday's 23:50
  // firing). The next real run, even mid-week, must still see it — but flagged onTime:false,
  // because `rig usage --period week` would now cover the NEW week, not the missed one.
  const now = new Date(2026, 7, 24); // Monday, not itself end-of-week
  const watermark = { lastWeekReported: '2026-08-16', lastMonthReported: completedMonthId(now) };
  const due = usageSchedulePeriodsDue(now, watermark);
  expect(due).toEqual([{ period: 'week', id: '2026-08-23', title: 'Weekly usage report', onTime: false, hasGap: false }]);
});

test('usageSchedulePeriodsDue: hasGap is true when the watermark is more than one boundary stale (review MEDIUM finding)', () => {
  // Machine slept through TWO Sundays (Aug 16 and Aug 23); wakes Monday Aug 31 — the catch-up
  // run lands on a NON-boundary day (late branch) and must still flag that Aug 23's week was
  // ALSO skipped, not just silently jump straight to Aug 30.
  const now = new Date(2026, 7, 31); // Monday
  const watermark = { lastWeekReported: '2026-08-09', lastMonthReported: null };
  const due = usageSchedulePeriodsDue(now, watermark);
  expect(due.find((d) => d.period === 'week')).toMatchObject({ id: '2026-08-30', onTime: false, hasGap: true });
});

test('usageSchedulePeriodsDue: hasGap is true even on the ON-TIME branch — a catch-up landing on a later boundary day must not silently swallow an earlier one (review MEDIUM finding)', () => {
  // Slept through Aug 23's 23:50 fire; wakes and the check next runs Aug 30 at 23:50 — a
  // BOUNDARY day, so onTime is true and a REAL report goes out, but Aug 23's week must not
  // vanish with zero mention just because this run happened to land on a later boundary.
  const now = atFireTime(2026, 7, 30);
  const watermark = { lastWeekReported: '2026-08-09', lastMonthReported: null };
  const due = usageSchedulePeriodsDue(now, watermark);
  expect(due.find((d) => d.period === 'week')).toMatchObject({ id: '2026-08-30', onTime: true, hasGap: true });
});

test('usageScheduleGapNote: names the period and says the earlier numbers are gone', () => {
  expect(usageScheduleGapNote('week')).toContain('earlier week');
  expect(usageScheduleGapNote('week')).toContain('gone');
  expect(usageScheduleGapNote('month')).toContain('earlier month');
});

test('usageSchedulePeriodsDue: both due AND on time the same day when a week ends on the last day of its month, checked at the fire time', () => {
  const bothTrue = atFireTime(2026, 4, 31); // confirmed Sunday + May's last day (see above), 23:50
  const due = usageSchedulePeriodsDue(bothTrue, EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(due.map((d) => d.period).sort()).toEqual(['month', 'week']);
  expect(due.every((d) => d.onTime)).toBe(true);
  expect(due.every((d) => !d.hasGap)).toBe(true); // fresh watermark, nothing to have skipped
});

test('seedUsageScheduleWatermarkFor: seeds the in-progress period as already-reported on a normal (non-boundary) day', () => {
  const seed = seedUsageScheduleWatermarkFor(new Date(2026, 7, 24)); // Monday, mid-August
  expect(seed).toEqual({ lastWeekReported: completedWeekId(new Date(2026, 7, 24)), lastMonthReported: completedMonthId(new Date(2026, 7, 24)) });
});

test('seedUsageScheduleWatermarkFor: on a boundary day BEFORE the fire time, seeds the PRIOR period — not the one that legitimately closes later tonight (review LOW finding)', () => {
  const earlyOnBoundaryDay = new Date(2026, 7, 30, 9, 0); // Sunday Aug 30, 09:00 — not closed yet
  const seed = seedUsageScheduleWatermarkFor(earlyOnBoundaryDay);
  expect(seed.lastWeekReported).toBe('2026-08-23'); // the PRIOR Sunday, not today's not-yet-closed '2026-08-30'
  // Tonight's real 23:50 fire then sees '2026-08-30' !== '2026-08-23' → correctly due, onTime, no gap.
  const duesTonight = usageSchedulePeriodsDue(atFireTime(2026, 7, 30), seed);
  expect(duesTonight.find((d) => d.period === 'week')).toMatchObject({ id: '2026-08-30', onTime: true, hasGap: false });
});

test('seedUsageScheduleWatermarkFor: on a boundary day AT/AFTER the fire time, seeds today\'s own (now genuinely closed) period', () => {
  const seed = seedUsageScheduleWatermarkFor(atFireTime(2026, 7, 30));
  expect(seed.lastWeekReported).toBe('2026-08-30');
});

test('shouldSeedUsageScheduleWatermark: true only on a genuinely absent file — a re-enable must never reseed and silently swallow a pending/failed period (review finding, two independent reviewers)', () => {
  expect(shouldSeedUsageScheduleWatermark(null)).toBe(true);
  // Any existing content — even a stale/all-null watermark from a prior enable — blocks reseeding.
  expect(shouldSeedUsageScheduleWatermark(JSON.stringify(EMPTY_USAGE_SCHEDULE_WATERMARK))).toBe(false);
  expect(shouldSeedUsageScheduleWatermark(JSON.stringify({ lastWeekReported: '2026-08-16', lastMonthReported: null }))).toBe(false);
  expect(shouldSeedUsageScheduleWatermark('garbage')).toBe(false); // re-enable must not clobber even unparseable content
  expect(shouldSeedUsageScheduleWatermark('')).toBe(false); // an empty (not absent) file still blocks reseeding
});

test('missedUsageReportNotice: names the period id, the cause, the fire time, and the by-hand command', () => {
  const week = missedUsageReportNotice({ period: 'week', id: '2026-08-23', title: 'Weekly usage report', onTime: false, hasGap: false });
  expect(week).toContain('Weekly usage report for the week ending 2026-08-23 was NOT generated');
  expect(week).toContain('asleep');
  expect(week).toContain('23:50');
  expect(week).toContain('rig usage --period week');
  expect(week.toLowerCase()).not.toContain('collapses to this single latest period'); // no gap, no footnote
  const month = missedUsageReportNotice({ period: 'month', id: '2026-07', title: 'Monthly usage report', onTime: false, hasGap: false });
  expect(month).toContain('for the month 2026-07');
  expect(month).toContain('rig usage --period month');
});

test('missedUsageReportNotice: appends the gap footnote ONLY when hasGap is true', () => {
  const withGap = missedUsageReportNotice({ period: 'week', id: '2026-08-23', title: 'Weekly usage report', onTime: false, hasGap: true });
  expect(withGap.toLowerCase()).toContain('collapses to this single latest period');
});

test('parseUsageScheduleWatermark: round-trips a valid file and fails CLOSED on garbage', () => {
  const wm = { lastWeekReported: '2026-08-23', lastMonthReported: '2026-07' };
  expect(parseUsageScheduleWatermark(JSON.stringify(wm))).toEqual(wm);
  // Missing / malformed / wrong-typed → "never reported" (at worst one duplicate report,
  // never a silently skipped one).
  expect(parseUsageScheduleWatermark(null)).toEqual(EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(parseUsageScheduleWatermark('')).toEqual(EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(parseUsageScheduleWatermark('{not json')).toEqual(EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(parseUsageScheduleWatermark('[1,2]')).toEqual(EMPTY_USAGE_SCHEDULE_WATERMARK);
  expect(parseUsageScheduleWatermark('{"lastWeekReported":7,"lastMonthReported":"2026-07"}')).toEqual({
    lastWeekReported: null,
    lastMonthReported: '2026-07',
  });
});

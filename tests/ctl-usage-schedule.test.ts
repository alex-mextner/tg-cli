// Tests for the pure usage-schedule policy (features/tg-ctl/usage-schedule.ts) — the
// end-of-week/end-of-month calendar logic and the launchd plist/plan builders for the
// scheduled `/usage` push. Pure — no real launchd, no I/O, no clock dependency (dates are
// passed in explicitly).
import { expect, test } from 'bun:test';
import {
  USAGE_SCHEDULE_LAUNCHD_LABEL,
  buildUsageScheduleDisablePlan,
  buildUsageScheduleEnablePlan,
  isEndOfMonth,
  isEndOfWeek,
  usageScheduleLaunchdPlist,
  usageScheduleLaunchdPlistPath,
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
  expect(plan.commands).toEqual([{ argv: ['launchctl', 'unload', plan.filePath], describe: 'unload the usage-schedule LaunchAgent (stops it)' }]);
});

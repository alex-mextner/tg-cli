// features/tg-ctl/usage-schedule.ts — periodic end-of-week / end-of-month usage report,
// pushed to Telegram automatically via `rig usage` + `tg`.
//
// Mirrors autostart.ts's plan/apply split: this module computes what to write and run
// (pure, unit-testable); the entrypoint (`tg-ctl usage-schedule enable|disable`, and the
// `usage-schedule-check` verb the installed job actually invokes) performs the real I/O.
//
// WHY a daily-firing job instead of encoding "end of week/month" directly in launchd's
// StartCalendarInterval: launchd calendar intervals have no "last day of month" concept
// (months have 28-31 days) and no simpler way to express "the Nth-to-last day" either — the
// standard workaround (used here) is to fire once a day at a fixed time and let the invoked
// command decide whether a report is due, no-op otherwise. This keeps the calendar logic
// in testable TypeScript instead of unverifiable plist XML.
//
// WHY the invoked command checks a WATERMARK (last-reported period id) rather than only "is
// TODAY the boundary": launchd's documented behavior for a missed StartCalendarInterval
// firing (machine asleep at 23:50) is to run at WAKE, not at the original time — a naive
// same-day check would then silently never mention that period at all, and a send that
// failed on the boundary day could never be retried. Comparing the current completed
// period's id against what was last reported makes the check idempotent (never a double
// send) and retryable (a failed send/compose leaves the period due).
//
// LIMIT (concurrency) — the check does an unlocked read-compose/send-write cycle with no
// per-bot lock. Two overlapping invocations (the daily launchd firing racing a manual
// `usage-schedule-check`, or an operator running two at once) can both see the same period
// due and both send it before either's watermark write lands — a benign DUPLICATE send,
// never a lost one (the watermark only ever moves the reported id forward). Accepted for
// now: this needs the daily job and a manual invocation to collide within the same
// read-to-write window, which the daemon's own single-process model doesn't otherwise
// produce; add a lock if that stops being true (e.g. a future multi-invocation trigger).
//
// LIMIT — a LATE run cannot produce the missed report's numbers: `rig usage --period
// week|month` reports the period CONTAINING now, to date (rig-cli's period_bounds), and
// has no "report this past window" flag. So a check that runs after the boundary day sends
// an explicit "report for <period> was missed" notice (and advances the watermark) instead
// of a report over the wrong window — honest, never silent, never wrong data. A real
// catch-up needs rig-cli to grow an as-of/window flag first (tracked as a follow-up).
//
// SCOPE: launchd (macOS) only, matching the platform this was built and verified against.
// A systemd --user `.timer` equivalent is NOT implemented — tracked as a follow-up, not
// silently gapped (see the PR this ships in).

import { defaultConfigDir, xmlEscape } from './autostart';

export const USAGE_SCHEDULE_LAUNCHD_LABEL = 'com.agenttools.tg-ctl.usage-schedule';

export function usageScheduleLaunchdPlistPath(home: string): string {
  return `${home}/Library/LaunchAgents/${USAGE_SCHEDULE_LAUNCHD_LABEL}.plist`;
}

// The single source of truth for the daily firing time — the plist's StartCalendarInterval,
// the missed-report notice's wording, and the boundary-day "has this period actually
// finished yet" gate below all read these two constants, so retuning the schedule can
// never leave the notice text or the on-time gate quoting a stale time (review finding).
export const USAGE_SCHEDULE_FIRE_HOUR = 23;
export const USAGE_SCHEDULE_FIRE_MINUTE = 50;
const FIRE_TIME_LABEL = `${String(USAGE_SCHEDULE_FIRE_HOUR).padStart(2, '0')}:${String(USAGE_SCHEDULE_FIRE_MINUTE).padStart(2, '0')}`;

// The days in `date`'s month (28-31), used by isEndOfMonth. `new Date(year, month+1, 0)` is
// the standard JS idiom for "day 0 of next month" == "last day of this month".
function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

// Sunday (getDay() === 0), local time — matches this codebase's ISO-week convention
// elsewhere (`rig usage`'s own week label is ISO 8601, Mon-Sun; Sunday is the last day).
export function isEndOfWeek(date: Date): boolean {
  return date.getDay() === 0;
}

export function isEndOfMonth(date: Date): boolean {
  return date.getDate() === daysInMonth(date);
}

function isAtOrPastFireTime(date: Date): boolean {
  if (date.getHours() > USAGE_SCHEDULE_FIRE_HOUR) return true;
  return date.getHours() === USAGE_SCHEDULE_FIRE_HOUR && date.getMinutes() >= USAGE_SCHEDULE_FIRE_MINUTE;
}

// Has the period ending on `date`'s boundary day actually FINISHED as of `date`? True for
// every date that ISN'T itself a boundary day (isEndOfWeek/isEndOfMonth already resolved to
// a day strictly in the past — its 23:50 has necessarily already passed). On the boundary
// day itself, true only from the scheduled fire time onward — review finding: without this,
// a wake-from-sleep run mid-morning on the boundary day (launchd deferred a MISSED 23:50
// firing from the night before to the next time the machine is awake, which can land
// earlier in the day than 23:50 on a later date, or — the sharper case — the check simply
// running by hand or via a differently-scheduled trigger before 23:50 on the boundary day
// itself) would treat the day's partial numbers as the final report and mark the period
// reported, permanently losing the rest of the day (`rig usage` can't re-report a past
// window). Before the fire time on the boundary day, the period is simply NOT DUE YET —
// no report, no "missed" notice either; the real 23:50 firing handles it normally.
function periodHasClosed(date: Date, period: 'week' | 'month'): boolean {
  const isBoundaryDay = period === 'week' ? isEndOfWeek(date) : isEndOfMonth(date);
  return !isBoundaryDay || isAtOrPastFireTime(date);
}

// The week/month id immediately BEFORE `id` — used to detect a multi-boundary gap (review
// finding: a catch-up run that lands ON a later boundary day takes the on-time branch and
// otherwise has no way to notice an EARLIER period was skipped entirely).
function previousWeekId(id: string): string {
  const [y, m, d] = id.split('-').map(Number);
  const sunday = new Date(y, m - 1, d);
  sunday.setDate(sunday.getDate() - 7);
  return `${sunday.getFullYear()}-${twoDigits(sunday.getMonth() + 1)}-${twoDigits(sunday.getDate())}`;
}

function previousMonthId(id: string): string {
  const [y, m] = id.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${twoDigits(m - 1)}`;
}

// A period-in-hand's watermark is "adjacent" (no gap) when it equals the id immediately
// preceding the one just computed, OR there was never a prior report at all (null — nothing
// to have skipped). Anything else means at least one earlier period was silently jumped over.
function hasSkippedGap(period: 'week' | 'month', id: string, watermark: UsageScheduleWatermark): boolean {
  const previous = watermark[period === 'week' ? 'lastWeekReported' : 'lastMonthReported'];
  if (previous === null) return false;
  return previous !== (period === 'week' ? previousWeekId(id) : previousMonthId(id));
}

// --- watermark-based period identification ---
//
// Identify the most recently COMPLETED week/month AS OF `now` (regardless of what day `now`
// actually is) and diff that identifier against a persisted "last reported" watermark — the
// scheduled check then catches up on the exact next run after any gap (asleep or not),
// instead of trusting "is TODAY the boundary" (see the header comment).

const twoDigits = (n: number): string => String(n).padStart(2, '0');

// The identifier for the most recently completed (or, if `date` IS a Sunday, currently
// completing) week: the ISO date (YYYY-MM-DD) of that week's Sunday. Using the literal
// Sunday date rather than an ISO week NUMBER sidesteps ISO week-numbering edge cases
// (week 1 of a year can start in the prior December, etc.) — this only needs to be a
// stable, monotonically-changing string, not a standards-compliant week label.
export function completedWeekId(date: Date): string {
  const sunday = new Date(date);
  sunday.setDate(sunday.getDate() - sunday.getDay());
  return `${sunday.getFullYear()}-${twoDigits(sunday.getMonth() + 1)}-${twoDigits(sunday.getDate())}`;
}

// The identifier (YYYY-MM) of the most recently completed (or, if `date` IS the last day
// of its month, currently completing) month.
export function completedMonthId(date: Date): string {
  if (isEndOfMonth(date)) {
    return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}`;
  }
  const lastOfPrevMonth = new Date(date.getFullYear(), date.getMonth(), 0);
  return `${lastOfPrevMonth.getFullYear()}-${twoDigits(lastOfPrevMonth.getMonth() + 1)}`;
}

export interface UsageScheduleWatermark {
  lastWeekReported: string | null;
  lastMonthReported: string | null;
}

export const EMPTY_USAGE_SCHEDULE_WATERMARK: UsageScheduleWatermark = {
  lastWeekReported: null,
  lastMonthReported: null,
};

// The watermark to seed on `enable`: the in-progress week/month is treated as already
// reported (nothing was being watched before now, so nothing was "missed"), UNLESS `now`
// is itself a boundary day that hasn't closed yet (before the fire time) — that period
// legitimately closes LATER TODAY and must still get its first real report tonight, so the
// seed steps back to the period before it instead (review finding: seeding today's
// not-yet-closed id here disagreed with periodHasClosed's own "not due yet" semantics and
// silently ate that day's only chance to be reported).
// Whether `enable` should (re)write the watermark file. Only a genuinely absent file (a
// true first enable) gets seeded — `enable` is also a supported RE-run (retry a
// half-failed load, re-pin PATH), and an unconditional reseed there would silently
// overwrite a real pending/failed period with "already reported", swallowing it with
// neither a report nor a missed notice (review finding, converged on by two independent
// reviewers). `existingRaw` is the raw file content (or null if absent) — pass
// `readFileOrNull(path)` straight through; this function does no I/O itself.
export function shouldSeedUsageScheduleWatermark(existingRaw: string | null): boolean {
  return existingRaw === null;
}

export function seedUsageScheduleWatermarkFor(now: Date): UsageScheduleWatermark {
  const weekToday = completedWeekId(now);
  const monthToday = completedMonthId(now);
  return {
    lastWeekReported: periodHasClosed(now, 'week') ? weekToday : previousWeekId(weekToday),
    lastMonthReported: periodHasClosed(now, 'month') ? monthToday : previousMonthId(monthToday),
  };
}

// Fail-closed parse of the on-disk watermark: anything malformed reads as "never reported",
// which at worst re-sends one report — never throws, never silently skips a period.
export function parseUsageScheduleWatermark(raw: string | null): UsageScheduleWatermark {
  if (!raw) return EMPTY_USAGE_SCHEDULE_WATERMARK;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return EMPTY_USAGE_SCHEDULE_WATERMARK;
    return {
      lastWeekReported: typeof parsed.lastWeekReported === 'string' ? parsed.lastWeekReported : null,
      lastMonthReported: typeof parsed.lastMonthReported === 'string' ? parsed.lastMonthReported : null,
    };
  } catch {
    return EMPTY_USAGE_SCHEDULE_WATERMARK;
  }
}

export interface UsageScheduleDuePeriod {
  period: 'week' | 'month';
  id: string;
  title: string;
  // true when `now` IS the period's boundary day, i.e. `rig usage --period <period>` covers
  // exactly the completing period; false on a late (post-boundary) run — see the module
  // header's LIMIT note: the runner then sends a missed-report notice, not wrong numbers.
  onTime: boolean;
  // true when the watermark shows at least one EARLIER period was never reported at all
  // (a gap spanning more than one boundary) — the caller appends a note either way (a real
  // report can carry it as a footnote; a missed-notice folds it into its own text), since
  // otherwise a multi-boundary gap on a LATE catch-up sends only the latest period with zero
  // mention that an earlier one was skipped, silently — the class of bug this flag exists
  // to prevent from recurring on the on-time branch too.
  hasGap: boolean;
}

// Which periods (if any) are due for a report right now, given the persisted watermark —
// pure decision function, no I/O. A period is due whenever its current completed-period
// id differs from what's recorded (covers both "never reported" — null — and "the
// recorded period has rolled over", which is what makes a missed exact-day firing visible
// on the next run instead of silently forgotten).
export function usageSchedulePeriodsDue(now: Date, watermark: UsageScheduleWatermark): UsageScheduleDuePeriod[] {
  const due: UsageScheduleDuePeriod[] = [];
  const weekId = completedWeekId(now);
  if (weekId !== watermark.lastWeekReported && periodHasClosed(now, 'week')) {
    due.push({ period: 'week', id: weekId, title: 'Weekly usage report', onTime: isEndOfWeek(now), hasGap: hasSkippedGap('week', weekId, watermark) });
  }
  const monthId = completedMonthId(now);
  if (monthId !== watermark.lastMonthReported && periodHasClosed(now, 'month')) {
    due.push({ period: 'month', id: monthId, title: 'Monthly usage report', onTime: isEndOfMonth(now), hasGap: hasSkippedGap('month', monthId, watermark) });
  }
  return due;
}

// The footnote appended when `hasGap` is true — shared by both the real report (on-time
// branch) and the missed-report notice (late branch), so a multi-boundary gap is NEVER
// reported with zero mention regardless of which branch the catch-up run happens to take.
export function usageScheduleGapNote(period: 'week' | 'month'): string {
  return `(An earlier ${period}'s report was ALSO not generated — a gap spanning more than one boundary collapses to this single latest period; the earlier one's numbers are gone.)`;
}

// The chat notice for a period whose scheduled check ran late (plain text — the caller
// escapes at its HTML boundary). Names the period id so the user can run `rig usage`
// themselves while the data is still there.
export function missedUsageReportNotice(due: UsageScheduleDuePeriod): string {
  const what = due.period === 'week' ? `the week ending ${due.id}` : `the month ${due.id}`;
  return (
    `${due.title} for ${what} was NOT generated: the scheduled check ran after the period ended ` +
    `(the machine was asleep or off at ${FIRE_TIME_LABEL} on the boundary day), and \`rig usage\` can only report ` +
    `the current ${due.period}. Run \`rig usage --period ${due.period}\` by hand if you still need it.` +
    (due.hasGap ? ` ${usageScheduleGapNote(due.period)}` : '')
  );
}

export interface UsageScheduleEnv {
  home: string;
  binPath: string;
  bunPath: string;
  logPath: string;
  // The config dir this was enabled with (ctx.configDir). Pinned into the plist only when
  // it differs from the daemon's own default — see usageScheduleUnitEnv.
  configDir: string;
  // $PATH from the shell that ran `tg-ctl usage-schedule enable`. Always pinned (unlike
  // configDir): launchd starts this job with a minimal PATH that does not include wherever
  // `tg`/`rig` are actually installed, and runUsageScheduleCheck shells out to both by bare
  // name — without this, the job runs "successfully" every night and silently sends nothing.
  pathEnv: string;
}

// EnvironmentVariables the scheduled job needs that launchd's own minimal env won't supply.
// PATH is unconditional (the job always shells out to `tg`/`rig`); TG_CTL_CONFIG_DIR mirrors
// autostart.ts's autostartUnitEnv — only pinned for a non-default dir, so the plist stays
// minimal for the common case.
function usageScheduleUnitEnv(env: UsageScheduleEnv): Array<[string, string]> {
  const pairs: Array<[string, string]> = [['PATH', env.pathEnv]];
  if (env.configDir && env.configDir !== defaultConfigDir(env.home)) {
    pairs.push(['TG_CTL_CONFIG_DIR', env.configDir]);
  }
  return pairs;
}

// The launchd LaunchAgent plist: fires once daily at 23:50 local time, running
// `usage-schedule-check` (a no-op on every day that isn't due a week/month report per
// the watermark). RunAtLoad is deliberately OMITTED — unlike the daemon's own autostart
// plist, this job should not fire immediately when installed/at every login, only on its
// StartCalendarInterval schedule.
export function usageScheduleLaunchdPlist(env: UsageScheduleEnv): string {
  const argv = [env.bunPath, env.binPath, 'usage-schedule-check'];
  const args = argv.map((a) => `\t\t<string>${xmlEscape(a)}</string>\n`).join('');
  const log = xmlEscape(env.logPath);
  const envBlock =
    '\t<key>EnvironmentVariables</key>\n' +
    '\t<dict>\n' +
    usageScheduleUnitEnv(env)
      .map(([k, v]) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t<string>${xmlEscape(v)}</string>\n`)
      .join('') +
    '\t</dict>\n';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '\t<key>Label</key>\n' +
    `\t<string>${xmlEscape(USAGE_SCHEDULE_LAUNCHD_LABEL)}</string>\n` +
    '\t<key>ProgramArguments</key>\n' +
    `\t<array>\n${args}\t</array>\n` +
    envBlock +
    '\t<key>StartCalendarInterval</key>\n' +
    '\t<dict>\n' +
    '\t\t<key>Hour</key>\n' +
    `\t\t<integer>${USAGE_SCHEDULE_FIRE_HOUR}</integer>\n` +
    '\t\t<key>Minute</key>\n' +
    `\t\t<integer>${USAGE_SCHEDULE_FIRE_MINUTE}</integer>\n` +
    '\t</dict>\n' +
    '\t<key>StandardOutPath</key>\n' +
    `\t<string>${log}</string>\n` +
    '\t<key>StandardErrorPath</key>\n' +
    `\t<string>${log}</string>\n` +
    '</dict>\n' +
    '</plist>\n'
  );
}

export interface UsageScheduleCommand {
  argv: string[];
  describe: string;
  optional?: boolean;
}

export interface UsageScheduleEnablePlan {
  file: { path: string; content: string; mode: number };
  commands: UsageScheduleCommand[];
}

export function buildUsageScheduleEnablePlan(env: UsageScheduleEnv): UsageScheduleEnablePlan {
  const path = usageScheduleLaunchdPlistPath(env.home);
  return {
    file: { path, content: usageScheduleLaunchdPlist(env), mode: 0o644 },
    commands: [
      { argv: ['launchctl', 'unload', path], describe: 'unload any existing usage-schedule job', optional: true },
      { argv: ['launchctl', 'load', path], describe: 'load the usage-schedule LaunchAgent' },
    ],
  };
}

export interface UsageScheduleDisablePlan {
  filePath: string;
  commands: UsageScheduleCommand[];
}

export function buildUsageScheduleDisablePlan(home: string): UsageScheduleDisablePlan {
  const path = usageScheduleLaunchdPlistPath(home);
  return {
    filePath: path,
    // `optional`: a half-failed enable (plist written, `launchctl load` failed) leaves a plist
    // that was never loaded — unloading it exits non-zero, and a MANDATORY unload would then
    // refuse to delete the file, stranding the user with a by-hand `rm`. Mirror enable's own
    // tolerance so disable always converges to "no plist, nothing loaded".
    commands: [
      { argv: ['launchctl', 'unload', path], describe: 'unload the usage-schedule LaunchAgent (stops it)', optional: true },
    ],
  };
}

// Harness limit-stop notifications + scheduled auto-continue (tg-cli#113).
//
// WHAT: when a Claude Code turn dies on a usage limit or API error, the harness
// fires its `StopFailure` hook. `tg-ctl harness-event` (the hook command) reads
// the hook payload, extracts the failure text from the transcript tail (the
// harness writes it as a synthetic assistant message, e.g. "You've hit your
// session limit · resets 4:10am (Europe/Belgrade)"), classifies it, and hands a
// `harness-limit` line to the daemon over the existing hook socket. The daemon
// notifies Telegram; when the reset time is parseable the card carries a
// one-tap "продолжить в <time>" button that schedules an automatic continue
// injection into the originating tmux pane at reset time.
//
// PURE: no I/O here. The tg-ctl entrypoint owns stdin/transcript reads, the
// socket, timers, persistence and the Bot API calls — same split as the rest of
// features/tg-ctl/ (see types.ts header).
//
// INVARIANTS:
// - Never fabricate a reset time: `resetAt` is null unless the text parses.
// - The store tolerates junk on disk (same posture as question-store.ts).
// - Callback data stays under Telegram's 64-byte cap (`tgw:<token>`, token is
//   a short daemon-minted id, never a pane id or path).

// --- failure classification ---

export type HarnessFailureKind = 'session-limit' | 'weekly-limit' | 'api-error' | 'unknown';

export interface HarnessFailure {
  kind: HarnessFailureKind;
  text: string; // the raw failure text as the harness rendered it
  resetAt: number | null; // epoch ms when limits reset, when parseable from text
}

// Freshness bound for a transcript failure line: a synthetic message older
// than this describes a PAST incident (an earlier failure still sitting in the
// tail), and notifying on it would report stale state as current. 10 min is
// generous — StopFailure fires within seconds of the failure line being written.
export const FAILURE_FRESHNESS_MS = 10 * 60_000;

// The transcript tail is JSONL; the failure line is an assistant message whose
// model is the literal "<synthetic>" (verified against real Claude Code 2.1.x
// transcripts). Returns the LAST such text — the failure that ended the turn.
// A truncated first line (we read a bounded tail, not the whole file) simply
// fails JSON.parse and is skipped.
//
// When `freshness` is given, a line carrying a parseable `timestamp` older
// than `maxAgeMs` is SKIPPED — the hook must never resurrect an old failure
// line as a fresh incident (the tail keeps earlier failures around). A line
// without a timestamp cannot be judged and is accepted.
export function extractFailureText(
  jsonlTail: string,
  freshness?: { nowMs: number; maxAgeMs: number },
): string | null {
  let found: string | null = null;
  for (const line of jsonlTail.split('\n')) {
    if (!line.includes('"<synthetic>"')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (freshness) {
      const ts = (obj as Record<string, unknown>).timestamp;
      if (typeof ts === 'string') {
        const at = Date.parse(ts);
        if (Number.isFinite(at) && freshness.nowMs - at > freshness.maxAgeMs) continue;
      }
    }
    const msg = (obj as Record<string, unknown> | null)?.message as Record<string, unknown> | undefined;
    if (!msg || msg.model !== '<synthetic>') continue;
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
          text += String((block as Record<string, unknown>).text ?? '');
        }
      }
    }
    text = text.trim();
    // "No response requested." is a benign synthetic, not a failure.
    if (text && text !== 'No response requested.') found = text;
  }
  return found;
}

// Classify the harness failure text. Kinds map to the observed message shapes:
//   session limit → "You've hit your session limit · resets 4:10am (Europe/Belgrade)"
//   weekly limit  → "You've hit your weekly limit · resets Jul 5 at 5am (Europe/Belgrade)"
//   API error     → "API Error: …" / "… is currently unavailable …" / spend limit
// Anything else is 'unknown' — still notified, never dropped.
export function classifyFailure(text: string, nowMs: number, defaultTz?: string): HarnessFailure {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower.includes('session limit')) {
    return { kind: 'session-limit', text: t, resetAt: parseResetTime(t, nowMs, defaultTz) };
  }
  if (lower.includes('weekly limit')) {
    return { kind: 'weekly-limit', text: t, resetAt: parseResetTime(t, nowMs, defaultTz) };
  }
  if (
    lower.startsWith('api error') ||
    lower.includes('currently unavailable') ||
    lower.includes('spend limit') ||
    lower.includes('not logged in')
  ) {
    return { kind: 'api-error', text: t, resetAt: null };
  }
  return { kind: 'unknown', text: t, resetAt: null };
}

// --- reset-time parsing ---

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "resets 4:10am (Europe/Belgrade)" | "resets 8pm (Europe/Belgrade)" |
// "resets Jul 5 at 5am (Europe/Belgrade)". The tz in parentheses is an IANA
// name; when absent we fall back to `defaultTz` (the machine tz in production,
// injected in tests). Returns epoch ms, or null when nothing parses — the
// caller then sends a button-less notification instead of guessing.
export function parseResetTime(text: string, nowMs: number, defaultTz?: string): number | null {
  const m = text.match(
    /resets\s+(?:([A-Za-z]{3})\w*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i,
  );
  if (!m) return null;
  const [, monName, dayStr, hourStr, minStr, ampm, tzName] = m;
  const tz = (tzName ?? defaultTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone).trim();
  let hour = Number(hourStr) % 12;
  if (ampm.toLowerCase() === 'pm') hour += 12;
  const minute = minStr ? Number(minStr) : 0;
  let today: { year: number; month: number; day: number };
  try {
    today = zonedDateParts(tz, nowMs);
  } catch {
    return null; // unknown tz name — refuse to guess
  }
  if (monName !== undefined && dayStr !== undefined) {
    const month = MONTHS[monName.toLowerCase().slice(0, 3)];
    if (month === undefined) return null;
    let candidate = zonedEpoch(tz, today.year, month, Number(dayStr), hour, minute);
    // A date far in the past means the year rolled over between the message and now.
    if (candidate < nowMs - 26 * 3_600_000) candidate = zonedEpoch(tz, today.year + 1, month, Number(dayStr), hour, minute);
    return candidate;
  }
  // Time-only: the next occurrence of that wall-clock time in tz.
  let candidate = zonedEpoch(tz, today.year, today.month, today.day, hour, minute);
  if (candidate <= nowMs + 60_000) {
    candidate = zonedEpoch(tz, today.year, today.month, today.day + 1, hour, minute); // Date.UTC handles overflow
  }
  return candidate;
}

// The tz offset (ms to ADD to an epoch to get that tz's wall clock as-if-UTC).
function tzOffsetMs(tz: string, atEpochMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(atEpochMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return asUtc - atEpochMs;
}

// Wall-clock (y, m, d, hh, mm) in tz → epoch ms. Two correction passes make it
// exact across DST boundaries (the second pass re-reads the offset at the
// first guess, which already lies within an hour of the true instant).
function zonedEpoch(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const wallUtc = Date.UTC(year, month, day, hour, minute);
  let guess = wallUtc - tzOffsetMs(tz, wallUtc);
  guess = wallUtc - tzOffsetMs(tz, guess);
  return guess;
}

function zonedDateParts(tz: string, atEpochMs: number): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(atEpochMs))) parts[p.type] = p.value;
  return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day) };
}

// --- socket line shapes (hook process → daemon) ---

export interface LimitStopEvent {
  kind: 'harness-limit';
  paneId?: string;
  sessionName?: string;
  cwd?: string;
  sessionId?: string;
  failure: HarnessFailure;
}

export interface ResumeEvent {
  kind: 'harness-resume';
  paneId: string;
}

// Tolerant normalization of a socket line (same trust model as
// normalizeButtonRequest: the socket is owner-only, but a malformed line must
// degrade to null, never throw into the poll loop).
export function normalizeLimitEvent(value: unknown): LimitStopEvent | ResumeEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'harness-resume') {
    return typeof v.paneId === 'string' && v.paneId ? { kind: 'harness-resume', paneId: v.paneId } : null;
  }
  if (v.kind !== 'harness-limit') return null;
  const f = v.failure as Record<string, unknown> | undefined;
  if (!f || typeof f !== 'object' || typeof f.text !== 'string') return null;
  const kind = f.kind;
  const known: HarnessFailureKind[] = ['session-limit', 'weekly-limit', 'api-error', 'unknown'];
  const failure: HarnessFailure = {
    kind: known.includes(kind as HarnessFailureKind) ? (kind as HarnessFailureKind) : 'unknown',
    text: f.text,
    resetAt: typeof f.resetAt === 'number' ? f.resetAt : null,
  };
  return {
    kind: 'harness-limit',
    paneId: typeof v.paneId === 'string' && v.paneId ? v.paneId : undefined,
    sessionName: typeof v.sessionName === 'string' && v.sessionName ? v.sessionName : undefined,
    cwd: typeof v.cwd === 'string' && v.cwd ? v.cwd : undefined,
    sessionId: typeof v.sessionId === 'string' && v.sessionId ? v.sessionId : undefined,
    failure,
  };
}

// --- scheduled-continue store (persisted like questions.json) ---

export interface LimitEntry {
  token: string; // daemon-minted, embedded in the button callback
  paneId?: string;
  cwd?: string;
  sessionName?: string;
  failureKind: HarnessFailureKind;
  failureText: string;
  resetAt: number | null; // epoch ms
  notifyMessageId: number | null; // the Telegram card carrying the button
  scheduled: boolean; // true once the button was tapped
  createdAt: number; // epoch ms
}

export interface LimitsStoreData {
  entries: LimitEntry[];
}

// How long an entry stays actionable. An entry WITH a reset time lives until
// well past that reset — a weekly limit's button must survive the multi-day
// wait (and a scheduled timer must survive restarts) — so its retention is
// keyed on resetAt, NOT createdAt (review catch: a createdAt-keyed 24h window
// silently killed scheduled weekly continues). A reset-less entry (API error,
// unknown) has nothing to wait for and expires on createdAt.
export const LIMIT_RETAIN_MS = 24 * 3_600_000;
export const LIMIT_PAST_RESET_RETAIN_MS = 6 * 3_600_000;

export function pruneLimitEntries(entries: LimitEntry[], nowMs: number): LimitEntry[] {
  return entries.filter((e) => {
    if (e.resetAt !== null) return nowMs - e.resetAt <= LIMIT_PAST_RESET_RETAIN_MS;
    return nowMs - e.createdAt <= LIMIT_RETAIN_MS;
  });
}

// A limit event whose reset time already passed describes a PAST state — the
// operator must never get a "stopped, resets at X" card when X is behind us
// (a stale replay / an old transcript line). The daemon and the hook client
// both apply this guard (defense in depth across restarts and clock drift).
export function isStaleLimitEvent(ev: LimitStopEvent, nowMs: number): boolean {
  return ev.failure.resetAt !== null && ev.failure.resetAt <= nowMs;
}

export function parseLimitsStore(raw: string | null, nowMs: number): LimitsStoreData {
  if (!raw) return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [] };
  }
  const arr = (parsed as Record<string, unknown> | null)?.entries;
  if (!Array.isArray(arr)) return { entries: [] };
  const out: LimitEntry[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.token !== 'string' || !r.token || typeof r.failureText !== 'string') continue;
    if (typeof r.createdAt !== 'number') continue;
    const known: HarnessFailureKind[] = ['session-limit', 'weekly-limit', 'api-error', 'unknown'];
    out.push({
      token: r.token,
      paneId: typeof r.paneId === 'string' && r.paneId ? r.paneId : undefined,
      cwd: typeof r.cwd === 'string' && r.cwd ? r.cwd : undefined,
      sessionName: typeof r.sessionName === 'string' && r.sessionName ? r.sessionName : undefined,
      failureKind: known.includes(r.failureKind as HarnessFailureKind) ? (r.failureKind as HarnessFailureKind) : 'unknown',
      failureText: r.failureText,
      resetAt: typeof r.resetAt === 'number' ? r.resetAt : null,
      notifyMessageId: typeof r.notifyMessageId === 'number' ? r.notifyMessageId : null,
      scheduled: r.scheduled === true,
      createdAt: r.createdAt,
    });
  }
  return { entries: pruneLimitEntries(out, nowMs) };
}

export function serializeLimitsStore(data: LimitsStoreData): string {
  return JSON.stringify(data);
}

// Two limit-stops for the same pane and the same reset instant are the same
// incident (StopFailure re-fires when a retry hits the same limit) — the
// daemon re-uses the existing entry instead of posting a duplicate card.
export function findDuplicateEntry(entries: LimitEntry[], ev: LimitStopEvent): LimitEntry | null {
  for (const e of entries) {
    if (!e.paneId || e.paneId !== ev.paneId) continue;
    if (e.failureKind !== ev.failure.kind) continue;
    if (e.resetAt === null && ev.failure.resetAt === null) return e;
    if (
      e.resetAt !== null &&
      ev.failure.resetAt !== null &&
      Math.abs(e.resetAt - ev.failure.resetAt) <= 60_000
    ) {
      return e;
    }
  }
  return null;
}

// --- button callback codec (`tgw:<token>`; the tg* prefix family is claimed
// in updates.ts — w for "wake") ---

export function buildLimitContinueCallback(token: string): string {
  return `tgw:${token}`;
}

export function parseLimitContinueCallback(data: string | undefined): string | null {
  if (!data || !data.startsWith('tgw:')) return null;
  const token = data.slice('tgw:'.length);
  return token ? token : null;
}

// --- notification composition ---

// Clock label for the button: "4:10" for today, "Jul 5, 05:00" when the reset
// is more than ~24h out (weekly limits). Formatted in `tz` (machine tz — the
// operator's phone shares it in practice).
export function formatResetClock(resetAt: number, nowMs: number, tz?: string): string {
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(
    new Date(resetAt),
  );
  if (resetAt - nowMs <= 24 * 3_600_000) return time;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }).format(
    new Date(resetAt),
  );
  return `${date}, ${time}`;
}

export interface LimitNotification {
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

const FAILURE_HEADLINE: Record<HarnessFailureKind, string> = {
  'session-limit': 'агент остановился: session limit',
  'weekly-limit': 'агент остановился: weekly limit',
  'api-error': 'агент остановился: API error',
  unknown: 'агент остановился: harness failure',
};

// A self-describing location label: "tmux <session>:<pane> · <dir>". Raw
// fragments like a bare "%0" read as broken placeholders on the phone
// (operator feedback), so every part is labeled. Trailing-slash cwds are
// tolerated (empty tail segments are skipped).
export function describeLimitLocation(ev: { sessionName?: string; paneId?: string; cwd?: string }): string {
  const parts: string[] = [];
  if (ev.sessionName && ev.paneId) parts.push(`tmux ${ev.sessionName}:${ev.paneId}`);
  else if (ev.sessionName) parts.push(`tmux ${ev.sessionName}`);
  else if (ev.paneId) parts.push(`pane ${ev.paneId}`);
  if (ev.cwd) {
    const tail = ev.cwd.split('/').filter(Boolean).slice(-1)[0];
    if (tail) parts.push(tail);
  }
  return parts.join(' · ');
}

// The card text + the optional schedule button. `where` labels the pane for
// the operator (window/session name when known, else the pane id / cwd tail).
export function buildLimitNotification(ev: LimitStopEvent, token: string, nowMs: number, tz?: string): LimitNotification {
  const lines = [`⛔ ${FAILURE_HEADLINE[ev.failure.kind]}`];
  const where = describeLimitLocation(ev);
  if (where) lines.push(where);
  lines.push(ev.failure.text);
  const text = lines.join('\n');
  if (ev.failure.resetAt === null || !ev.paneId) {
    // No parseable reset time (or no pane to continue in) → informational card only.
    return { text };
  }
  const clock = formatResetClock(ev.failure.resetAt, nowMs, tz);
  return {
    text,
    reply_markup: {
      inline_keyboard: [[{ text: `продолжить в ${clock}`, callback_data: buildLimitContinueCallback(token) }]],
    },
  };
}

// What the timer injects into the pane when it fires. Wrapped by the caller
// via the standard injectWrap (so the agent sees the usual [TG from …] shape).
export const AUTO_CONTINUE_TEXT = 'продолжай';
export const AUTO_CONTINUE_SENDER = 'auto-continue';

// Grace added past the advertised reset instant before injecting — limits
// reset on a minute boundary and firing exactly on it races the enforcement.
export const CONTINUE_GRACE_MS = 2 * 60_000;

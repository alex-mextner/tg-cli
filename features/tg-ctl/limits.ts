// Harness failure notifications + auto-continue scheduling (tg-cli#113).
//
// Runtime path: Claude Code 2.1.x fires a `StopFailure` hook when a turn ends on
// an API failure (matchers: rate_limit, overloaded, billing_error, …) OR the
// usage/session limit is hit; the exact failure text — including the reset time
// ("… resets 4:10am (Europe/Belgrade)") — is a synthetic assistant message at
// the tail of the transcript. `tg-ctl harness-event` reads that payload on stdin
// (the entrypoint owns the stdin + transcript file I/O), normalizes it into a
// HarnessFailureEvent, and this PURE module decides the Telegram notification and
// the auto-continue schedule. No I/O here — the daemon sends/persists/schedules.
//
// Two bugs this module fixes by construction (a previous WIP leaked a real,
// stale "session limit" alert to the operator's chat with an unrendered "%0"
// placeholder):
//   - Staleness guard: buildLimitNotification returns null when the reset time
//     is already in the PAST — a limit whose window already elapsed is not worth
//     alerting (the agent could just continue), and re-emitting it is the leak.
//   - Templating: every string is built with template literals + escapeHtml,
//     never a printf-style "%s"/"%0" placeholder that can render literally.

import { escapeHtml } from '../render/html';

// setTimeout clamps a delay > 2^31-1 ms to ~1ms (fires immediately) — the same
// trap the daemon already documents for its other timers. Clamp so a reset far
// in the future schedules at the max instead of firing at once.
export const MAX_TIMER_MS = 2 ** 31 - 1;

// Telegram callback_data is capped at 64 bytes. `lc:<paneId>:<resetAtMs>` fits
// easily (a tmux paneId is `%<n>`, the epoch is ~13 digits).
export const LIMIT_CONTINUE_PREFIX = 'lc';

export type HarnessFailureKind = 'session-limit' | 'api-error';

// A normalized harness failure. The entrypoint builds this from the StopFailure
// payload + transcript tail; every field the notification needs is explicit so
// this module stays pure and testable.
export interface HarnessFailureEvent {
  kind: HarnessFailureKind;
  agent: string; // tmux window / session name the failed pane belongs to
  paneId: string | null; // originating pane — required to arm auto-continue
  reason: string; // the StopFailure matcher (rate_limit, overloaded, session_limit, …)
  detail: string; // human-readable tail (trimmed synthetic message)
  resetAt: number | null; // ms epoch when the limit resets; null = unknown/not a limit
  sourceMessageId: number | null; // last inbound message routed to that pane (reaction flip)
}

export interface LimitNotification {
  text: string; // HTML body (basic tags only — valid inside a plain sendMessage)
  button: { label: string; data: string } | null; // present iff auto-continue is armable
  resetAt: number | null;
}

// Map a StopFailure matcher to a notification kind. A matcher naming a limit
// (session/usage/rate) is a schedulable stop; anything else (overloaded,
// billing_error, api_error, …) is a plain error alert. The presence of a reset
// time — not this label — is what actually decides whether a button is offered.
export function classifyFailure(reason: string): HarnessFailureKind {
  return /limit/i.test(reason) ? 'session-limit' : 'api-error';
}

// Parse a reset time out of failure text → next future ms epoch, or null.
// Handles an explicit ISO/absolute timestamp and the wall-clock forms Claude
// emits ("resets 4:10am", "reset at 3pm", "resets 16:10"). A bare wall clock is
// resolved to its NEXT occurrence in the daemon's local timezone (which is the
// operator's — the reset text's "(Europe/Belgrade)" is that same zone).
export function parseResetTime(text: string, now: number): number | null {
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (isoMatch) {
    const t = Date.parse(isoMatch[0].replace(' ', 'T'));
    if (Number.isFinite(t)) return t;
  }
  const clockMatch = text.match(/reset[s]?(?:\s+(?:at|by))?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (!clockMatch) return null;
  const clock = parseClock(clockMatch[1], clockMatch[2], clockMatch[3]);
  return clock ? nextWallClock(now, clock.hour, clock.minute) : null;
}

// A 12h ("4:10am"/"3pm") or 24h ("16:10") clock → {hour, minute}, or null on an
// out-of-range value (13pm, 24:00, minute 60). am/pm normalizes 12h→24h.
function parseClock(hStr: string, mStr: string | undefined, ampm: string | undefined): { hour: number; minute: number } | null {
  let hour = Number(hStr);
  const minute = mStr ? Number(mStr) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  const suffix = ampm?.toLowerCase().replace(/\./g, '');
  if (suffix === 'am' || suffix === 'pm') {
    if (hour < 1 || hour > 12) return null;
    if (suffix === 'pm' && hour !== 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return { hour, minute };
}

// The next future instant matching a local wall clock. Today's occurrence if it
// is still ahead of `now`, else the same time tomorrow.
function nextWallClock(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 60 * 60 * 1000;
  return t;
}

// Build the operator notification, or null to SUPPRESS it. Suppressed when the
// reset time is already in the past (stale — the leak this module prevents).
export function buildLimitNotification(ev: HarnessFailureEvent, now: number): LimitNotification | null {
  if (ev.resetAt !== null && ev.resetAt <= now) return null; // staleness guard
  const agent = escapeHtml(ev.agent || 'agent');
  const head =
    ev.kind === 'session-limit'
      ? `⚠️ <b>${agent}</b> hit its session limit.`
      : `⚠️ <b>${agent}</b> stopped on an API error (${escapeHtml(ev.reason || 'unknown')}).`;
  const when = resetLine(ev, now);
  const detail = ev.detail ? `\n<blockquote>${escapeHtml(ev.detail)}</blockquote>` : '';
  const button =
    ev.resetAt !== null && ev.paneId
      ? { label: `▶️ Auto-continue at ${formatClock(ev.resetAt)}`, data: continueCallbackData(ev.paneId, ev.resetAt) }
      : null;
  return { text: `${head}${when}${detail}`, button, resetAt: ev.resetAt };
}

function resetLine(ev: HarnessFailureEvent, now: number): string {
  if (ev.resetAt !== null) return `\nResets at <b>${formatClock(ev.resetAt)}</b> (in ${formatDelta(ev.resetAt - now)}).`;
  return ev.kind === 'session-limit' ? `\nReset time unknown — continue manually.` : '';
}

// Delay until an armed auto-continue should fire: never negative (a past reset
// fires immediately), never above the setTimeout ceiling.
export function autoContinueDelayMs(resetAt: number, now: number): number {
  return Math.max(0, Math.min(resetAt - now, MAX_TIMER_MS));
}

export function continueCallbackData(paneId: string, resetAt: number): string {
  return `${LIMIT_CONTINUE_PREFIX}:${paneId}:${resetAt}`;
}

// Inverse of continueCallbackData. Returns null for anything that is not a
// well-formed auto-continue tap (a foreign or truncated callback).
export function parseContinueCallback(data: string): { paneId: string; resetAt: number } | null {
  const m = data.match(/^lc:(.+):(\d+)$/);
  if (!m) return null;
  return { paneId: m[1], resetAt: Number(m[2]) };
}

// Local HH:MM (24h) for a ms epoch — stable, locale-independent formatting.
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// A coarse human delta ("2h 5m", "45m", "<1m") for "in …" copy.
export function formatDelta(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

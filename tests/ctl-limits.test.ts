import { expect, test } from 'bun:test';
import {
  autoContinueDelayMs,
  buildLimitNotification,
  classifyFailure,
  continueCallbackData,
  formatClock,
  formatDelta,
  MAX_TIMER_MS,
  parseContinueCallback,
  parseResetTime,
  type HarnessFailureEvent,
} from '../features/tg-ctl/limits';

// A fixed local reference so wall-clock resolution is deterministic regardless of
// when the suite runs. 2026-07-02 12:00 local.
const NOW = new Date(2026, 6, 2, 12, 0, 0, 0).getTime();

const ev = (over: Partial<HarnessFailureEvent> = {}): HarnessFailureEvent => ({
  kind: 'session-limit',
  agent: 'hyperide',
  paneId: '%3',
  reason: 'session_limit',
  detail: '',
  resetAt: null,
  sourceMessageId: null,
  ...over,
});

test('classifyFailure: a limit matcher is a session-limit, everything else an api-error', () => {
  expect(classifyFailure('session_limit')).toBe('session-limit');
  expect(classifyFailure('rate_limit')).toBe('session-limit');
  expect(classifyFailure('overloaded')).toBe('api-error');
  expect(classifyFailure('billing_error')).toBe('api-error');
});

test('parseResetTime: 12h wall clock resolves to the next future occurrence (local)', () => {
  // 4:10am is BEFORE 12:00 now → tomorrow 04:10.
  const r = parseResetTime('You have hit your session limit · resets 4:10am (Europe/Belgrade)', NOW);
  expect(r).not.toBeNull();
  const d = new Date(r!);
  expect(d.getHours()).toBe(4);
  expect(d.getMinutes()).toBe(10);
  expect(d.getDate()).toBe(3); // rolled to tomorrow
});

test('parseResetTime: a time later today stays today', () => {
  const r = parseResetTime('5-hour limit reached ∙ resets 3pm', NOW);
  const d = new Date(r!);
  expect(d.getHours()).toBe(15);
  expect(d.getMinutes()).toBe(0);
  expect(d.getDate()).toBe(2); // still today
});

test('parseResetTime: 24h form and "reset at" phrasing', () => {
  expect(new Date(parseResetTime('resets 16:10', NOW)!).getHours()).toBe(16);
  expect(new Date(parseResetTime('Your limit will reset at 4am', NOW)!).getHours()).toBe(4);
  expect(new Date(parseResetTime('resets 12pm', NOW)!).getHours()).toBe(12);
  expect(new Date(parseResetTime('resets 12am', NOW)!).getHours()).toBe(0);
});

test('parseResetTime: explicit ISO timestamp wins', () => {
  const r = parseResetTime('resets at 2026-07-02T04:10:00+02:00', NOW);
  expect(r).toBe(Date.parse('2026-07-02T04:10:00+02:00'));
});

test('parseResetTime: no reset info → null; nonsense clock → null', () => {
  expect(parseResetTime('overloaded_error: please try again', NOW)).toBeNull();
  expect(parseResetTime('resets 13pm', NOW)).toBeNull();
  expect(parseResetTime('resets 25:00', NOW)).toBeNull();
});

test('staleness guard: a limit whose reset is already past is SUPPRESSED (null)', () => {
  const past = NOW - 60_000;
  expect(buildLimitNotification(ev({ resetAt: past }), NOW)).toBeNull();
  // exactly now also counts as past
  expect(buildLimitNotification(ev({ resetAt: NOW }), NOW)).toBeNull();
});

test('notification: future reset → text + auto-continue button; no unrendered placeholder', () => {
  const future = NOW + 3 * 60 * 60_000 + 5 * 60_000; // +3h05m
  const n = buildLimitNotification(ev({ resetAt: future }), NOW)!;
  expect(n).not.toBeNull();
  expect(n.text).toContain('hyperide');
  expect(n.text).toContain('Resets at');
  expect(n.text).toContain('in 3h 5m');
  expect(n.button).not.toBeNull();
  expect(n.button!.data).toBe(continueCallbackData('%3', future));
  // bug (c): the rendered text must never carry a printf-style or template token.
  expect(n.text).not.toMatch(/%\d/);
  expect(n.text).not.toMatch(/%s/);
  expect(n.text).not.toMatch(/\{[a-z]+\}/i);
});

test('notification: session-limit with unknown reset → alert, no button, NOT suppressed', () => {
  const n = buildLimitNotification(ev({ resetAt: null }), NOW)!;
  expect(n).not.toBeNull();
  expect(n.button).toBeNull();
  expect(n.text).toContain('Reset time unknown');
});

test('notification: api-error → alert with reason, no button', () => {
  const n = buildLimitNotification(ev({ kind: 'api-error', reason: 'overloaded', resetAt: null }), NOW)!;
  expect(n.text).toContain('API error');
  expect(n.text).toContain('overloaded');
  expect(n.button).toBeNull();
});

test('notification: no button when the reset is known but the pane is not', () => {
  const n = buildLimitNotification(ev({ resetAt: NOW + 60_000, paneId: null }), NOW)!;
  expect(n.button).toBeNull();
});

test('notification: agent name is HTML-escaped', () => {
  const n = buildLimitNotification(ev({ agent: 'a<b>&c', resetAt: NOW + 60_000 }), NOW)!;
  expect(n.text).toContain('a&lt;b&gt;&amp;c');
  expect(n.text).not.toContain('a<b>&c');
});

test('autoContinueDelayMs: future = remaining, past = 0, far future clamped', () => {
  expect(autoContinueDelayMs(NOW + 5000, NOW)).toBe(5000);
  expect(autoContinueDelayMs(NOW - 5000, NOW)).toBe(0);
  expect(autoContinueDelayMs(NOW + MAX_TIMER_MS * 3, NOW)).toBe(MAX_TIMER_MS);
});

test('parseContinueCallback: round-trips a valid tap, rejects foreign data', () => {
  const data = continueCallbackData('%12', 1720000000000);
  expect(parseContinueCallback(data)).toEqual({ paneId: '%12', resetAt: 1720000000000 });
  expect(parseContinueCallback('agent:foo:1')).toBeNull();
  expect(parseContinueCallback('lc:%3:notanumber')).toBeNull();
});

test('formatClock / formatDelta', () => {
  expect(formatClock(new Date(2026, 0, 1, 4, 5).getTime())).toBe('04:05');
  expect(formatDelta(45 * 60_000)).toBe('45m');
  expect(formatDelta(125 * 60_000)).toBe('2h 5m');
  expect(formatDelta(30_000)).toBe('<1m');
});

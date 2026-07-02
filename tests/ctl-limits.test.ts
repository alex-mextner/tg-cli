import { expect, test } from 'bun:test';
import {
  autoContinueDelayMs,
  buildLimitNotification,
  classifyFailure,
  continueCallbackData,
  extractAssistantText,
  extractFailure,
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

test('parseResetTime: a bare count near "resets" is NOT a time (no false positive)', () => {
  expect(parseResetTime('the counter resets 3 times per hour', NOW)).toBeNull();
  expect(parseResetTime('resets 5 requests remaining', NOW)).toBeNull();
});

test('parseResetTime: an unrelated ISO timestamp far from "reset" is ignored', () => {
  // A transcript line stamp must not be mistaken for the reset time.
  const text = '2020-01-01T00:00:00Z the agent said hi. later: your session limit resets 4:10am';
  const r = parseResetTime(text, NOW);
  expect(new Date(r!).getHours()).toBe(4); // the wall clock near "resets", not the 2020 stamp
});

test('extractAssistantText: pulls the LAST assistant message, both content shapes, ignoring stamps', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-07-02T09:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] }, timestamp: '2026-07-02T09:01:00.000Z' }),
    JSON.stringify({ role: 'assistant', content: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)' }),
    'not json — skipped',
  ].join('\n');
  const text = extractAssistantText(jsonl);
  expect(text).toContain('session limit');
  expect(text).not.toContain('2026-07-02T09'); // no timestamp bled in
});

test('extractAssistantText + extractFailure: a realistic JSONL transcript yields the reset + clean detail', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-07-02T08:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'You have hit your session limit · resets 4:10am (Europe/Belgrade)' }] }, timestamp: '2026-07-02T10:00:00.000Z' }),
  ].join('\n');
  const f = extractFailure('session_limit', extractAssistantText(jsonl), NOW);
  expect(f.kind).toBe('session-limit');
  expect(new Date(f.resetAt!).getHours()).toBe(4);
  // detail is clean prose, NOT a raw JSONL line with a timestamp
  expect(f.detail).toContain('session limit');
  expect(f.detail).not.toContain('timestamp');
  expect(f.detail).not.toContain('{');
});

test('staleness guard: a limit whose reset is already past is SUPPRESSED (null)', () => {
  const past = NOW - 60_000;
  expect(buildLimitNotification(ev({ resetAt: past }), NOW)).toBeNull();
  // exactly now also counts as past
  expect(buildLimitNotification(ev({ resetAt: NOW }), NOW)).toBeNull();
});

test('notification: future reset → text + auto-continue button; no unrendered placeholder', () => {
  const future = NOW + 3 * 60 * 60_000 + 5 * 60_000; // +3h05m
  const n = buildLimitNotification(ev({ resetAt: future, sourceMessageId: 55 }), NOW)!;
  expect(n).not.toBeNull();
  expect(n.text).toContain('hyperide');
  expect(n.text).toContain('Resets at');
  expect(n.text).toContain('in 3h 5m');
  expect(n.button).not.toBeNull();
  // the source message id is threaded into the button so the resume flip can find it
  expect(n.button!.data).toBe(continueCallbackData('%3', future, 55));
  expect(n.button!.data).toContain(':55');
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

test('parseContinueCallback: round-trips a tap with/without a source id, rejects foreign data', () => {
  expect(parseContinueCallback(continueCallbackData('%12', 1720000000000))).toEqual({
    paneId: '%12',
    resetAt: 1720000000000,
    sourceMessageId: null,
  });
  // the source message id survives the round-trip and is NOT swallowed into paneId
  expect(parseContinueCallback(continueCallbackData('%3', 1720000000000, 55))).toEqual({
    paneId: '%3',
    resetAt: 1720000000000,
    sourceMessageId: 55,
  });
  expect(parseContinueCallback('agent:foo:1')).toBeNull();
  expect(parseContinueCallback('lc:%3:notanumber')).toBeNull();
});

test('extractFailure: a session-limit tail yields kind=session-limit + resetAt + detail', () => {
  const text = 'Claude is thinking…\nYou have hit your session limit · resets 4:10am (Europe/Belgrade)';
  const f = extractFailure('session_limit', text, NOW);
  expect(f.kind).toBe('session-limit');
  expect(f.resetAt).not.toBeNull();
  expect(new Date(f.resetAt!).getHours()).toBe(4);
  expect(f.detail).toContain('session limit');
});

test('extractFailure: a reset time upgrades a vague matcher to session-limit', () => {
  const f = extractFailure('', 'rate limited, resets 3pm', NOW);
  expect(f.kind).toBe('session-limit');
});

test('extractFailure: an API error with no reset → api-error, null resetAt', () => {
  const f = extractFailure('overloaded', 'Error: overloaded_error (529)', NOW);
  expect(f.kind).toBe('api-error');
  expect(f.resetAt).toBeNull();
  expect(f.detail).toContain('overloaded');
});

test('formatClock / formatDelta', () => {
  expect(formatClock(new Date(2026, 0, 1, 4, 5).getTime())).toBe('04:05');
  expect(formatDelta(45 * 60_000)).toBe('45m');
  expect(formatDelta(125 * 60_000)).toBe('2h 5m');
  expect(formatDelta(30_000)).toBe('<1m');
});

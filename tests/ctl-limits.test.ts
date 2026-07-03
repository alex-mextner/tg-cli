import { describe, expect, test } from 'bun:test';
import {
  AUTO_CONTINUE_TEXT,
  FAILURE_FRESHNESS_MS,
  buildLimitContinueCallback,
  buildLimitNotification,
  classifyFailure,
  describeLimitLocation,
  extractFailureText,
  findDuplicateEntry,
  formatResetClock,
  isStaleLimitEvent,
  normalizeLimitEvent,
  parseLimitContinueCallback,
  parseLimitsStore,
  parseResetTime,
  pruneLimitEntries,
  serializeLimitsStore,
  type LimitEntry,
  type LimitStopEvent,
} from '../features/tg-ctl/limits';

// Unit coverage for the pure limit-stop module (tg-cli#113). Time-sensitive
// tests pin `now` and the tz explicitly so they never depend on the machine.

const TZ = 'Europe/Belgrade';
// 2026-07-01 12:00:00 Europe/Belgrade (CEST, UTC+2) = 10:00:00Z.
const NOW = Date.UTC(2026, 6, 1, 10, 0, 0);

function syntheticLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  });
}

describe('extractFailureText', () => {
  test('finds the last synthetic assistant text among noise', () => {
    const tail = [
      '{"type":"user","message":{"role":"user","content":"hello"}}',
      syntheticLine('API Error: 529 Overloaded'),
      '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"real reply"}]}}',
      syntheticLine("You've hit your session limit · resets 4:10am (Europe/Belgrade)"),
    ].join('\n');
    expect(extractFailureText(tail)).toBe("You've hit your session limit · resets 4:10am (Europe/Belgrade)");
  });

  test('skips a truncated first line and benign synthetics', () => {
    const tail = ['odel":"<synthetic>","content":[{"type":"text","te', syntheticLine('No response requested.')].join('\n');
    expect(extractFailureText(tail)).toBeNull();
  });

  test('string content form is read too', () => {
    const line = JSON.stringify({ message: { model: '<synthetic>', content: 'Not logged in · Please run /login' } });
    expect(extractFailureText(line)).toBe('Not logged in · Please run /login');
  });

  test('no synthetic entry → null', () => {
    expect(extractFailureText('{"type":"user"}\n')).toBeNull();
  });

  test('freshness filter: an old-timestamped failure line is skipped, a fresh one kept', () => {
    const old = JSON.stringify({
      timestamp: new Date(NOW - FAILURE_FRESHNESS_MS - 60_000).toISOString(),
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'OLD failure' }] },
    });
    const fresh = JSON.stringify({
      timestamp: new Date(NOW - 5_000).toISOString(),
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'FRESH failure' }] },
    });
    const freshness = { nowMs: NOW, maxAgeMs: FAILURE_FRESHNESS_MS };
    expect(extractFailureText(old, freshness)).toBeNull();
    expect(extractFailureText(`${old}\n${fresh}`, freshness)).toBe('FRESH failure');
    // A line with no timestamp cannot be judged → accepted.
    expect(extractFailureText(syntheticLine('untimestamped'), freshness)).toBe('untimestamped');
    // Without the freshness opt (plain extraction), old lines still count.
    expect(extractFailureText(old)).toBe('OLD failure');
  });
});

describe('classifyFailure', () => {
  test('session limit with reset time', () => {
    const f = classifyFailure("You've hit your session limit · resets 4:10am (Europe/Belgrade)", NOW, TZ);
    expect(f.kind).toBe('session-limit');
    expect(f.resetAt).not.toBeNull();
  });

  test('weekly limit with date reset', () => {
    const f = classifyFailure("You've hit your weekly limit · resets Jul 5 at 5am (Europe/Belgrade)", NOW, TZ);
    expect(f.kind).toBe('weekly-limit');
    // 2026-07-05 05:00 CEST = 03:00Z
    expect(f.resetAt).toBe(Date.UTC(2026, 6, 5, 3, 0, 0));
  });

  test('api error variants → api-error, no reset', () => {
    for (const t of [
      'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
      'Claude Fable 5 is currently unavailable. Learn more: https://example.com',
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      'Not logged in · Please run /login',
    ]) {
      const f = classifyFailure(t, NOW, TZ);
      expect(f.kind).toBe('api-error');
      expect(f.resetAt).toBeNull();
    }
  });

  test('anything else → unknown, still carried', () => {
    const f = classifyFailure('something exploded', NOW, TZ);
    expect(f.kind).toBe('unknown');
    expect(f.text).toBe('something exploded');
  });
});

describe('parseResetTime', () => {
  test('time-only later today resolves to today in the stated tz', () => {
    // 4:10pm CEST on 2026-07-01 = 14:10Z — after NOW (10:00Z).
    expect(parseResetTime('resets 4:10pm (Europe/Belgrade)', NOW, TZ)).toBe(Date.UTC(2026, 6, 1, 14, 10));
  });

  test('time-only already past rolls to tomorrow', () => {
    // 4:10am CEST = 02:10Z — before NOW → tomorrow 02:10Z.
    expect(parseResetTime('resets 4:10am (Europe/Belgrade)', NOW, TZ)).toBe(Date.UTC(2026, 6, 2, 2, 10));
  });

  test('hour-only pm without minutes', () => {
    // 8pm CEST = 18:00Z today.
    expect(parseResetTime('resets 8pm (Europe/Belgrade)', NOW, TZ)).toBe(Date.UTC(2026, 6, 1, 18, 0));
  });

  test('month-day form', () => {
    expect(parseResetTime('resets Jul 5 at 5am (Europe/Belgrade)', NOW, TZ)).toBe(Date.UTC(2026, 6, 5, 3, 0));
  });

  test('missing tz falls back to the provided default', () => {
    expect(parseResetTime('resets 4:10pm', NOW, TZ)).toBe(Date.UTC(2026, 6, 1, 14, 10));
  });

  test('12am and 12pm map to 0 and 12', () => {
    // 12pm CEST = 10:00Z — not strictly after NOW+60s → rolls to tomorrow.
    expect(parseResetTime('resets 12pm (Europe/Belgrade)', NOW, TZ)).toBe(Date.UTC(2026, 6, 2, 10, 0));
    // 12am CEST = 22:00Z previous day; past → tomorrow's midnight = 2026-07-01T22:00Z.
    expect(parseResetTime('resets 12am (Europe/Belgrade)', NOW, TZ)).toBe(Date.UTC(2026, 6, 1, 22, 0));
  });

  test('garbage → null; unknown tz → null', () => {
    expect(parseResetTime('no reset here', NOW, TZ)).toBeNull();
    expect(parseResetTime('resets 4:10am (Mars/Olympus)', NOW, TZ)).toBeNull();
  });
});

describe('normalizeLimitEvent', () => {
  test('round-trips a limit event and fills defaults', () => {
    const ev = normalizeLimitEvent({
      kind: 'harness-limit',
      paneId: '%7',
      failure: { kind: 'session-limit', text: 'x', resetAt: 123 },
    }) as LimitStopEvent;
    expect(ev.kind).toBe('harness-limit');
    expect(ev.paneId).toBe('%7');
    expect(ev.failure.resetAt).toBe(123);
  });

  test('unknown failure kind degrades to unknown; junk → null', () => {
    const ev = normalizeLimitEvent({ kind: 'harness-limit', failure: { kind: 'zap', text: 'x' } }) as LimitStopEvent;
    expect(ev.failure.kind).toBe('unknown');
    expect(normalizeLimitEvent({ kind: 'harness-limit' })).toBeNull();
    expect(normalizeLimitEvent('nope')).toBeNull();
    expect(normalizeLimitEvent({ kind: 'harness-resume' })).toBeNull();
  });

  test('resume event needs a pane', () => {
    expect(normalizeLimitEvent({ kind: 'harness-resume', paneId: '%3' })).toEqual({ kind: 'harness-resume', paneId: '%3' });
  });
});

describe('limits store', () => {
  const entry: LimitEntry = {
    token: 't1',
    paneId: '%7',
    failureKind: 'session-limit',
    failureText: 'limit',
    resetAt: NOW + 3_600_000,
    notifyMessageId: 42,
    scheduled: true,
    createdAt: NOW,
  };

  test('serialize/parse round-trip', () => {
    const raw = serializeLimitsStore({ entries: [entry] });
    expect(parseLimitsStore(raw, NOW).entries).toEqual([entry]);
  });

  test('junk and malformed entries are dropped', () => {
    expect(parseLimitsStore('not json', NOW).entries).toEqual([]);
    expect(parseLimitsStore(JSON.stringify({ entries: [{ token: '' }, 7] }), NOW).entries).toEqual([]);
    expect(parseLimitsStore(null, NOW).entries).toEqual([]);
  });

  test('pruning: long past reset or ancient reset-less entries drop', () => {
    const pastReset: LimitEntry = { ...entry, token: 'old', resetAt: NOW - 7 * 3_600_000 };
    const ancient: LimitEntry = { ...entry, token: 'ancient', resetAt: null, createdAt: NOW - 25 * 3_600_000 };
    expect(pruneLimitEntries([entry, pastReset, ancient], NOW)).toEqual([entry]);
  });

  test('pruning: a weekly entry with a future reset survives an old createdAt (review catch)', () => {
    // Scheduled 4 days ahead, created 25h ago: the timer must survive restarts
    // for the whole multi-day wait — retention is keyed on resetAt, not createdAt.
    const weekly: LimitEntry = {
      ...entry,
      token: 'weekly',
      failureKind: 'weekly-limit',
      resetAt: NOW + 4 * 24 * 3_600_000,
      createdAt: NOW - 25 * 3_600_000,
    };
    expect(pruneLimitEntries([weekly], NOW)).toEqual([weekly]);
  });

  test('isStaleLimitEvent: past reset is stale, future or unknown reset is not', () => {
    const mk = (resetAt: number | null): LimitStopEvent => ({
      kind: 'harness-limit',
      paneId: '%1',
      failure: { kind: 'session-limit', text: 'x', resetAt },
    });
    expect(isStaleLimitEvent(mk(NOW - 1), NOW)).toBe(true);
    expect(isStaleLimitEvent(mk(NOW + 60_000), NOW)).toBe(false);
    expect(isStaleLimitEvent(mk(null), NOW)).toBe(false);
  });

  test('duplicate detection keys on pane + kind + reset instant', () => {
    const ev: LimitStopEvent = {
      kind: 'harness-limit',
      paneId: '%7',
      failure: { kind: 'session-limit', text: 'limit', resetAt: entry.resetAt! + 30_000 },
    };
    expect(findDuplicateEntry([entry], ev)?.token).toBe('t1');
    expect(findDuplicateEntry([entry], { ...ev, paneId: '%9' })).toBeNull();
    expect(findDuplicateEntry([entry], { ...ev, failure: { ...ev.failure, resetAt: entry.resetAt! + 120_000 } })).toBeNull();
  });
});

describe('callback codec', () => {
  test('round-trip and rejection', () => {
    expect(parseLimitContinueCallback(buildLimitContinueCallback('abc'))).toBe('abc');
    expect(parseLimitContinueCallback('tgq:abc')).toBeNull();
    expect(parseLimitContinueCallback('tgw:')).toBeNull();
    expect(parseLimitContinueCallback(undefined)).toBeNull();
  });
});

describe('buildLimitNotification', () => {
  const base: LimitStopEvent = {
    kind: 'harness-limit',
    paneId: '%7',
    sessionName: 'rig',
    cwd: '/Users/x/xp/tg-cli',
    failure: {
      kind: 'session-limit',
      text: "You've hit your session limit · resets 4:10pm (Europe/Belgrade)",
      resetAt: Date.UTC(2026, 6, 1, 14, 10),
    },
  };

  test('location label is self-describing — no bare pane ids (operator feedback: "4 · %0" read as garbage)', () => {
    expect(describeLimitLocation({ sessionName: '4', paneId: '%0', cwd: '/Users/x/xp/tg-cli' })).toBe('tmux 4:%0 · tg-cli');
    expect(describeLimitLocation({ paneId: '%7' })).toBe('pane %7');
    expect(describeLimitLocation({ sessionName: 'rig' })).toBe('tmux rig');
    // Trailing slash must not produce an empty dir segment.
    expect(describeLimitLocation({ cwd: '/tmp/proj/' })).toBe('proj');
    expect(describeLimitLocation({})).toBe('');
  });

  test('with reset time: card carries the schedule button with the clock', () => {
    const n = buildLimitNotification(base, 'tok1', NOW, TZ);
    expect(n.text).toContain('session limit');
    expect(n.text).toContain('tmux rig:%7');
    expect(n.text).toContain('tg-cli');
    const btn = n.reply_markup!.inline_keyboard[0][0];
    expect(btn.text).toBe('продолжить в 16:10');
    expect(btn.callback_data).toBe('tgw:tok1');
    expect(btn.callback_data.length).toBeLessThanOrEqual(64);
  });

  test('no reset time or no pane → no button', () => {
    expect(buildLimitNotification({ ...base, failure: { ...base.failure, resetAt: null } }, 't', NOW, TZ).reply_markup).toBeUndefined();
    expect(buildLimitNotification({ ...base, paneId: undefined }, 't', NOW, TZ).reply_markup).toBeUndefined();
  });

  test('weekly reset more than a day out gets a dated clock', () => {
    const resetAt = Date.UTC(2026, 6, 5, 3, 0);
    const n = buildLimitNotification({ ...base, failure: { kind: 'weekly-limit', text: 'w', resetAt } }, 't', NOW, TZ);
    expect(n.reply_markup!.inline_keyboard[0][0].text).toBe('продолжить в Jul 5, 05:00');
  });

  test('formatResetClock stays within same-day for <24h', () => {
    expect(formatResetClock(Date.UTC(2026, 6, 1, 14, 10), NOW, TZ)).toBe('16:10');
  });

  test('auto-continue text is the verbatim ask', () => {
    expect(AUTO_CONTINUE_TEXT).toBe('продолжай');
  });
});

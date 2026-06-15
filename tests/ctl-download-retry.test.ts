import { expect, test } from 'bun:test';
import { backoffDelayMs, retryFetch, type RetryInfo } from '../features/tg-ctl/retry';

// retryFetch is the bounded retry-with-backoff that the inbound media download
// handler (tg-ctl downloadFileToCache) wraps around BOTH network steps (getFile
// + the file-bytes download). Before it existed, a single transient blip on
// either fetch silently lost the inbound voice note / photo / doc. These tests
// stub the fetch thunk (no real network, no real sleeping — sleep is injected)
// and assert: success on the first try; recovery after a transient failure;
// give-up after N attempts for both thrown errors and non-2xx responses.

// Real Response objects — retryFetch only reads `.ok`/`.status`, and the real
// constructor keeps the test honest (no `as unknown as Response` cast).
function ok(): Response {
  return new Response('ok', { status: 200 });
}
function err(status = 503): Response {
  return new Response('nope', { status });
}

// Sleep stub that records the waited delays instead of actually waiting, so the
// test runs instantly while still proving backoff fired between attempts.
function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

test('returns the response on the first try with no retries', async () => {
  let calls = 0;
  const { delays, sleep } = recordingSleep();
  const resp = await retryFetch(
    async () => {
      calls++;
      return ok();
    },
    { sleep },
  );
  expect(resp.ok).toBe(true);
  expect(calls).toBe(1);
  expect(delays).toHaveLength(0); // no backoff on a clean first try
});

test('retries a transient network error then succeeds, with a full onRetry payload', async () => {
  let calls = 0;
  const seen: RetryInfo[] = [];
  const { delays, sleep } = recordingSleep();
  const resp = await retryFetch(
    async () => {
      calls++;
      if (calls < 2) throw new Error('ECONNRESET');
      return ok();
    },
    { sleep, random: () => 0, onRetry: (i) => seen.push(i) },
  );
  expect(resp.ok).toBe(true);
  expect(calls).toBe(2); // one failure, one success
  expect(delays).toEqual([300]); // first backoff (random()=0 → no jitter)
  // The whole onRetry contract is exercised, not just `attempt`.
  expect(seen).toHaveLength(1);
  expect(seen[0].attempt).toBe(1);
  expect(seen[0].maxAttempts).toBe(3); // default
  expect(seen[0].delayMs).toBe(300);
  expect(seen[0].reason).toBeInstanceOf(Error); // a thrown failure → Error reason
  expect((seen[0].reason as Error).message).toBe('ECONNRESET');
});

test('retries a transient non-2xx response then succeeds, reason is the Response', async () => {
  let calls = 0;
  const seen: RetryInfo[] = [];
  const { delays, sleep } = recordingSleep();
  const resp = await retryFetch(
    async () => {
      calls++;
      return calls < 3 ? err(503) : ok();
    },
    { sleep, random: () => 0, onRetry: (i) => seen.push(i) },
  );
  expect(resp.ok).toBe(true);
  expect(calls).toBe(3);
  expect(delays).toEqual([300, 900]); // two backoffs: 300, 300·3
  // A non-2xx failure surfaces the Response itself as the reason.
  expect(seen.map((i) => i.attempt)).toEqual([1, 2]);
  expect(seen[0].reason).toBeInstanceOf(Response);
  expect((seen[0].reason as Response).status).toBe(503);
});

test('gives up after maxAttempts on a persistent thrown error (re-throws last)', async () => {
  let calls = 0;
  const { delays, sleep } = recordingSleep();
  await expect(
    retryFetch(
      async () => {
        calls++;
        throw new Error(`boom ${calls}`);
      },
      { maxAttempts: 3, sleep, random: () => 0 },
    ),
  ).rejects.toThrow('boom 3'); // the LAST error is surfaced
  expect(calls).toBe(3); // exactly N attempts, no more
  expect(delays).toEqual([300, 900]); // backoff between the 3 attempts (2 gaps)
});

test('gives up after maxAttempts on a persistent non-2xx (returns last response)', async () => {
  let calls = 0;
  const { delays, sleep } = recordingSleep();
  const resp = await retryFetch(
    async () => {
      calls++;
      return err(500);
    },
    { maxAttempts: 3, sleep, random: () => 0 },
  );
  // The final non-ok Response is returned (caller's own !resp.ok path fires) —
  // it is NOT thrown, preserving the single-fetch caller contract.
  expect(resp.ok).toBe(false);
  expect(resp.status).toBe(500);
  expect(calls).toBe(3);
  expect(delays).toEqual([300, 900]);
});

test('maxAttempts:1 disables retry — first success returned, first failure surfaced, no sleep/onRetry', async () => {
  // Success path: one call, no backoff, no onRetry.
  {
    let calls = 0;
    let retries = 0;
    const { delays, sleep } = recordingSleep();
    const resp = await retryFetch(
      async () => {
        calls++;
        return ok();
      },
      { maxAttempts: 1, sleep, onRetry: () => retries++ },
    );
    expect(resp.ok).toBe(true);
    expect(calls).toBe(1);
    expect(delays).toHaveLength(0);
    expect(retries).toBe(0);
  }
  // Thrown failure: surfaced immediately, no retry.
  {
    let calls = 0;
    let retries = 0;
    const { delays, sleep } = recordingSleep();
    await expect(
      retryFetch(
        async () => {
          calls++;
          throw new Error('once');
        },
        { maxAttempts: 1, sleep, onRetry: () => retries++ },
      ),
    ).rejects.toThrow('once');
    expect(calls).toBe(1);
    expect(delays).toHaveLength(0);
    expect(retries).toBe(0);
  }
  // Non-2xx failure: the lone Response is returned, not thrown.
  {
    let calls = 0;
    const { delays, sleep } = recordingSleep();
    const resp = await retryFetch(
      async () => {
        calls++;
        return err(502);
      },
      { maxAttempts: 1, sleep },
    );
    expect(resp.status).toBe(502);
    expect(calls).toBe(1);
    expect(delays).toHaveLength(0);
  }
});

test('backoffDelayMs grows exponentially with an exact jitter ceiling', () => {
  // No jitter (random=0): clean 300 → 900 → 2700 schedule.
  expect(backoffDelayMs(1, { random: () => 0 })).toBe(300);
  expect(backoffDelayMs(2, { random: () => 0 })).toBe(900);
  expect(backoffDelayMs(3, { random: () => 0 })).toBe(2700);
  // Max jitter (random→1): exactly +25% (default jitter 0.25) at every level.
  expect(backoffDelayMs(1, { random: () => 1 })).toBe(375); // 300·1.25
  expect(backoffDelayMs(2, { random: () => 1 })).toBe(1125); // 900·1.25
  expect(backoffDelayMs(3, { random: () => 1 })).toBe(3375); // 2700·1.25
  // Mid jitter is exact too — guards against jitter being silently dropped.
  expect(backoffDelayMs(1, { random: () => 0.5 })).toBe(338); // round(300·1.125)
});

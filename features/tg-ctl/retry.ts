// Bounded retry-with-backoff for the inbound media download path.
//
// Why this exists: the daemon's `downloadFileToCache` (tg-ctl) did a single
// `getFile` fetch and a single file-bytes fetch. ANY transient blip — a dropped
// connection, a 5xx, a timeout — turned the inbound voice note / photo / doc
// into a silently-lost message (logged "media download failed", returned null,
// and the poll offset was already persisted so there was no second chance).
//
// This wraps a single fetch thunk in a bounded exponential-backoff loop so a
// transient failure is retried before the message is abandoned. It is a PURE
// module (no real effect of its own): the caller passes the fetch thunk and an
// optional `sleep` (so tests run instantly) and `onRetry` (for logging). The
// caller contract is unchanged — on final failure we re-throw the last error,
// or return the last non-2xx Response, exactly as a single `fetch` would have.

/** Why a single attempt failed: a thrown error, or a non-2xx Response. */
export interface RetryInfo {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Total attempts this call is allowed (mirrors `maxAttempts`). */
  maxAttempts: number;
  /** Backoff about to be waited before the next attempt, in ms. */
  delayMs: number;
  /** The failure: an Error (thrown / network / timeout) or the non-ok Response. */
  reason: Error | Response;
}

export interface RetryFetchOpts {
  /** Total attempts including the first try (NOT the retry count). Default 3. */
  maxAttempts?: number;
  /** Backoff before the FIRST retry, in ms (grows by `factor` each retry). Default 300. */
  baseDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Default 3 → 300, 900, 2700. */
  factor?: number;
  /** Jitter fraction in [0, 1): each delay is multiplied by 1 + random·jitter. Default 0.25. */
  jitter?: number;
  /** Sleep used between attempts. Injected so tests don't actually wait. Default Bun.sleep. */
  sleep?: (ms: number) => Promise<unknown>;
  /** Source of randomness for jitter; MUST return a value in [0, 1). Default Math.random. */
  random?: () => number;
  /** Called once per failed-and-will-be-retried attempt. For logging only. */
  onRetry?: (info: RetryInfo) => void;
}

/** Default retry schedule — the single source of truth for the 300→900→2700 backoff. */
export const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 300,
  factor: 3,
  jitter: 0.25,
} as const;

/**
 * Compute the (jittered) backoff delay before the retry that follows a given
 * 1-based attempt number. attempt=1 → baseDelayMs, attempt=2 → baseDelayMs·factor, …
 * A pure function of its inputs; `random` MUST return a value in [0, 1) (the
 * jitter is `1 + random·jitter`).
 */
export function backoffDelayMs(
  attempt: number,
  opts: Pick<RetryFetchOpts, 'baseDelayMs' | 'factor' | 'jitter' | 'random'> = {},
): number {
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const factor = opts.factor ?? DEFAULT_RETRY.factor;
  const jitter = opts.jitter ?? DEFAULT_RETRY.jitter;
  const random = opts.random ?? Math.random;
  const raw = baseDelayMs * factor ** (attempt - 1);
  return Math.round(raw * (1 + random() * jitter));
}

/**
 * Run `thunk` (a `fetch` call) with bounded retry-with-backoff. Retries when the
 * thunk throws (network error / abort / timeout) OR resolves to a non-2xx
 * Response. Returns the first 2xx Response. After the last attempt it surfaces
 * the failure exactly as a bare fetch would: it returns the final non-ok
 * Response (so the caller's existing `!resp.ok` handling fires) or re-throws the
 * final thrown error.
 */
export async function retryFetch(thunk: () => Promise<Response>, opts: RetryFetchOpts = {}): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
  const sleep = opts.sleep ?? Bun.sleep;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp: Response | undefined;
    let reason: Error | Response;
    try {
      resp = await thunk();
      if (resp.ok) return resp;
      reason = resp; // non-2xx — retryable
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      reason = lastError;
    }

    if (attempt === maxAttempts) {
      // Out of retries: surface the failure like a single fetch would have —
      // return the final non-ok Response, else re-throw the final error.
      if (resp) return resp;
      throw lastError ?? new Error('retryFetch: thunk failed with no error');
    }

    const delayMs = backoffDelayMs(attempt, opts);
    opts.onRetry?.({ attempt, maxAttempts, delayMs, reason });
    await sleep(delayMs);
  }

  // The loop always returns or throws on attempt === maxAttempts above.
  throw new Error('retryFetch: unreachable');
}

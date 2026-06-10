// Linear response cache for the autolink-tasks feature (1h TTL).
//
// Each verified code is cached as either a positive entry (TicketInfo) or a
// NEGATIVE one (info: null — Linear confirmed the issue does not exist), so a
// report repeatedly mentioning the same missing code doesn't re-spawn the CLI
// every send. Pure string→state helpers; the tg entrypoint owns the file I/O
// (~/.cache/tg-cli/linear-cache.json) and treats every failure as cache-miss /
// don't-persist — a stale-but-bounded cache must never block or break a send.

import type { TicketInfo } from './linear';

export const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  t: number; // epoch ms when the entry was written
  info: TicketInfo | null; // null = verified-absent in Linear
}

export interface CacheSplit {
  // code → cached verdict (TicketInfo or null for verified-absent)
  hits: Map<string, TicketInfo | null>;
  // codes that need a live probe, in input order
  missing: string[];
}

function parseEntries(raw: string | null): Record<string, CacheEntry> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    const entries = parsed?.entries;
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return {};
    const out: Record<string, CacheEntry> = {};
    for (const [code, value] of Object.entries(entries as Record<string, unknown>)) {
      const e = value as { t?: unknown; info?: unknown };
      if (typeof e?.t !== 'number') continue;
      const info = e.info as TicketInfo | null;
      if (info !== null) {
        if (typeof info?.code !== 'string' || typeof info?.title !== 'string' || typeof info?.url !== 'string') {
          continue;
        }
      }
      out[code] = { t: e.t, info };
    }
    return out;
  } catch {
    return {};
  }
}

/** Split codes into fresh cache hits and codes needing a live probe. */
export function splitByCache(codes: string[], raw: string | null, now: number): CacheSplit {
  const entries = parseEntries(raw);
  const hits = new Map<string, TicketInfo | null>();
  const missing: string[] = [];
  for (const code of codes) {
    const entry = entries[code];
    if (entry && now - entry.t < CACHE_TTL_MS) {
      hits.set(code, entry.info);
    } else {
      missing.push(code);
    }
  }
  return { hits, missing };
}

/**
 * Fold a probe result back into the cache: every probed code gets a fresh
 * entry (positive when Linear returned it, negative otherwise). Unrelated
 * fresh entries are kept; expired ones are pruned so the file stays small.
 */
export function mergeIntoCache(
  raw: string | null,
  probedCodes: string[],
  tickets: Map<string, TicketInfo>,
  now: number,
): string {
  const entries = parseEntries(raw);
  for (const [code, entry] of Object.entries(entries)) {
    if (now - entry.t >= CACHE_TTL_MS) delete entries[code];
  }
  for (const code of probedCodes) {
    entries[code] = { t: now, info: tickets.get(code) ?? null };
  }
  return JSON.stringify({ entries });
}

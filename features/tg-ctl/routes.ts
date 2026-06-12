// Outbound message → pane routes, written by `tg` on every send and read by the
// daemon to recognize replies and order the /agent picker by LRU+MRU
// (docs/specs/reply-quotes.md, item: reply routing).
//
// PURE: `tg` and `tg-ctl` own the file I/O; these helpers parse/append/query the
// plain JSON array. A reply to a message whose id is in the map routes straight
// to that pane; an unrecognized reply falls back to the picker, whose candidates
// are ordered by how recently + how often each pane was last messaged — both
// derived from this same map (no separate usage state).

export interface Route {
  id: number; // Telegram message_id of an outbound message
  paneId: string; // the tmux pane that produced it (`tg`'s TMUX_PANE)
  cwd?: string;
  ts: number; // unix seconds (send time)
}

// Keep the tail only — recency is what matters for both recognition and LRU/MRU,
// and the file must not grow unbounded across a long-lived session.
export const MAX_ROUTES = 300;

export function parseRoutes(raw: string | null): Route[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Route[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.id !== 'number' || typeof rec.paneId !== 'string' || typeof rec.ts !== 'number') continue;
    out.push({ id: rec.id, paneId: rec.paneId, cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined, ts: rec.ts });
  }
  return out;
}

// Append a route, dropping any prior entry for the same message id, capped to the
// last MAX_ROUTES (first-in-first-out by position = chronological by send).
export function appendRoute(existing: Route[], route: Route): Route[] {
  const kept = existing.filter((r) => r.id !== route.id);
  kept.push(route);
  return kept.length > MAX_ROUTES ? kept.slice(kept.length - MAX_ROUTES) : kept;
}

export function serializeRoutes(routes: Route[]): string {
  return JSON.stringify(routes);
}

// The pane that produced `messageId`, or null when unrecognized. The LAST entry
// wins (ids are unique after appendRoute, but be defensive).
export function recognizeRoute(routes: Route[], messageId: number): Route | null {
  for (let i = routes.length - 1; i >= 0; i--) {
    if (routes[i].id === messageId) return routes[i];
  }
  return null;
}

export interface PaneUsage {
  lastTs: number; // most recent send to this pane (MRU)
  count: number; // number of sends to this pane in the window (MFU)
}

// Aggregate the routes per pane into recency + frequency.
export function aggregateUsage(routes: Route[]): Map<string, PaneUsage> {
  const usage = new Map<string, PaneUsage>();
  for (const r of routes) {
    const u = usage.get(r.paneId);
    if (u) {
      u.count += 1;
      if (r.ts > u.lastTs) u.lastTs = r.ts;
    } else {
      usage.set(r.paneId, { lastTs: r.ts, count: 1 });
    }
  }
  return usage;
}

// Order pane ids by LRU+MRU: most-recently-messaged first, frequency as the
// tiebreaker, then panes with no history last (stable by their input order).
export function orderByLruMru(paneIds: string[], usage: Map<string, PaneUsage>): string[] {
  return paneIds
    .map((paneId, idx) => ({ paneId, idx, u: usage.get(paneId) }))
    .sort((a, b) => {
      if (a.u && b.u) {
        if (b.u.lastTs !== a.u.lastTs) return b.u.lastTs - a.u.lastTs;
        if (b.u.count !== a.u.count) return b.u.count - a.u.count;
        return a.idx - b.idx;
      }
      if (a.u) return -1;
      if (b.u) return 1;
      return a.idx - b.idx;
    })
    .map((x) => x.paneId);
}

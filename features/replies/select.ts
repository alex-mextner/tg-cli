// `tg replies` selection + formatting. PURE — the entrypoint reads the history
// file + detects the pane, then calls these to filter, search, order, and
// render. Time formatting is INJECTED (fmtTime) so the daemon can render local
// time while tests stay deterministic — the same pattern updates.ts uses.

import type { HistoryRecord } from './history';
import type { Direction, RepliesQuery } from './args';

export type { HistoryRecord } from './history';

// --- filters ---

// Keep only records in the requested direction. `all` is a pass-through.
export function filterByDirection(records: HistoryRecord[], direction: Direction): HistoryRecord[] {
  if (direction === 'all') return records;
  return records.filter((r) => r.direction === direction);
}

// Scope to one tmux pane. A null pane means "no scope" (--all-sessions or no
// detectable pane). A record whose own pane is null never matches a concrete
// scope — it was logged outside tmux and belongs to no session.
export function filterByPane(records: HistoryRecord[], pane: string | null): HistoryRecord[] {
  if (pane === null) return records;
  return records.filter((r) => r.pane === pane);
}

// --- search ---

// Case-insensitive substring (default) or regex search over record text. A
// regex is compiled with the `i` flag; an invalid pattern throws (the
// entrypoint turns that into a clean stderr error + exit 1).
export function searchHistory(records: HistoryRecord[], query: string, regex: boolean): HistoryRecord[] {
  if (regex) {
    const re = new RegExp(query, 'i'); // may throw — caller catches
    return records.filter((r) => re.test(r.text));
  }
  const needle = query.toLowerCase();
  return records.filter((r) => r.text.toLowerCase().includes(needle));
}

// --- selection pipeline ---

// direction → pane → (find ? search) → keep the LAST `limit`, oldest→newest.
// The pane scope is resolved by the entrypoint (args.session / detected pane /
// null for --all-sessions) and passed in; keeping it a param keeps this pure.
export function selectHistory(
  records: HistoryRecord[],
  args: RepliesQuery,
  pane: string | null = null,
): HistoryRecord[] {
  let out = filterByDirection(records, args.direction);
  out = filterByPane(out, pane);
  if (args.action === 'find' && args.query !== undefined) {
    out = searchHistory(out, args.query, args.regex);
  }
  // History is already chronological; take the tail, render ascending.
  return out.length > args.limit ? out.slice(out.length - args.limit) : out;
}

// --- formatting ---

// Default truncation for a list/find line (the CTO asked for "~200 chars").
export const TEXT_TRUNCATE = 200;

// Deterministic UTC `YYYY-MM-DD HH:MM` — the default when no fmtTime is given.
// The entrypoint injects a LOCAL-time formatter (Europe/Belgrade for the CTO).
export function fmtTimeUtc(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes(),
  )}`;
}

export interface FormatLineOpts {
  showMarker: boolean; // prefix ←/→ (used for `all`; off for single-direction)
  full: boolean; // skip the ~200-char truncation
  fmtTime: (unixSec: number) => string;
}

// One record → one line: `[<time>] #<id> <text>`, optionally prefixed with a
// direction marker (← user / → agent) for `all` mode. Internal newlines are
// collapsed to spaces so each record stays one grep-able line; long text is
// truncated with an ellipsis unless `full`.
export function formatLine(rec: HistoryRecord, opts: FormatLineOpts): string {
  const time = opts.fmtTime(rec.ts);
  const id = rec.message_id === null ? '?' : String(rec.message_id);
  const oneLine = rec.text.replace(/\s*\n\s*/g, ' ');
  const body = !opts.full && oneLine.length > TEXT_TRUNCATE ? `${oneLine.slice(0, TEXT_TRUNCATE)}…` : oneLine;
  const core = `[${time}] #${id} ${body}`;
  if (!opts.showMarker) return core;
  const marker = rec.direction === 'agent' ? '→' : '←';
  return `${marker} ${core}`;
}

export interface FormatLinesOpts {
  direction: Direction;
  full: boolean;
  fmtTime: (unixSec: number) => string;
}

// Render a list of records. Markers are shown ONLY for `all` (a single-direction
// view doesn't need to repeat ←/→ on every line).
export function formatLines(records: HistoryRecord[], opts: FormatLinesOpts): string[] {
  const showMarker = opts.direction === 'all';
  return records.map((r) => formatLine(r, { showMarker, full: opts.full, fmtTime: opts.fmtTime }));
}

// --- JSON output (--json) ---

export interface HistoryJson {
  ts: number; // epoch MILLISECONDS (history stores seconds; ms is the JS norm)
  id: number | null;
  direction: Direction;
  from: string;
  text: string;
  pane: string | null;
}

export function buildJsonOutput(records: HistoryRecord[]): HistoryJson[] {
  return records.map((r) => ({
    ts: r.ts * 1000,
    id: r.message_id,
    direction: r.direction,
    from: r.from,
    text: r.text,
    pane: r.pane,
  }));
}

// PURE (de)serialization for the daemon's durable auto-continue schedules
// (CtlPaths.schedules), tg-cli#113. The entrypoint owns the file I/O (atomicWrite
// + readFileOrNull) and the setTimeout arming; this module owns only the on-disk
// FORMAT — the versioned envelope, record validation, and dead-entry pruning.
//
// Why persist: an auto-continue armed by a button tap lives as a setTimeout in
// the daemon. A restart (crash-relaunch, or a deliberate stop+start) between the
// tap and the reset time would silently drop the timer — the exact overnight
// stall the feature exists to prevent. Persisting the schedule lets a restored
// daemon re-arm every pending continue (firing immediately for any whose reset
// already passed while it was down).

export interface AutoContinueSchedule {
  paneId: string; // originating tmux pane the continue is injected into
  resetAt: number; // ms epoch when the continue should fire
  agent: string; // window/session name (resume copy + logging)
  sourceMessageId: number | null; // inbound message to flip back to 👀 on resume
  cardMessageId: number | null; // the notification card — its button is cleared on fire
  armedAt: number; // ms epoch the tap armed it (bookkeeping / ordering)
}

export interface ScheduleStoreData {
  schedules: AutoContinueSchedule[];
}

const STORE_VERSION = 1;

// A schedule whose reset is more than a day in the PAST is dead — the daemon was
// down long past the window, injecting "continue" now would be surprising. Drop
// it rather than fire it on a late restart. Exported so the entrypoint can apply
// the SAME threshold to a fresh button tap (see isDeadReset) — a stale inline
// keyboard tapped long after its reset must not arm either (PR #120 review: it
// used to bypass this guard entirely since it never round-trips through prune).
export const DEAD_AFTER_MS = 24 * 60 * 60 * 1000;

// Bounds the on-disk file on a long-lived daemon; freshest (latest armed) kept.
const MAX_SCHEDULES = 100;

function isValid(r: unknown): r is AutoContinueSchedule {
  if (!r || typeof r !== 'object') return false;
  const s = r as Record<string, unknown>;
  return (
    typeof s.paneId === 'string' &&
    typeof s.resetAt === 'number' &&
    Number.isFinite(s.resetAt) &&
    typeof s.agent === 'string' &&
    (s.sourceMessageId === null || typeof s.sourceMessageId === 'number') &&
    (s.cardMessageId === null || typeof s.cardMessageId === 'number') &&
    typeof s.armedAt === 'number'
  );
}

// A reset far enough in the past that arming/firing it is no longer meaningful
// (see DEAD_AFTER_MS) — the same "dead" test `prune` applies on restart, reused
// so a first-time button tap gets the identical guard. A non-finite resetAt
// (NaN/Infinity — a malformed callback_data upstream of the current regex
// parse, or a future change to it) counts as dead too: `NaN < x` is always
// false, so without this an unparseable reset would silently SKIP the guard
// it exists to enforce (review round on PR #120) instead of being rejected.
export function isDeadReset(resetAt: number, now: number): boolean {
  return !Number.isFinite(resetAt) || resetAt < now - DEAD_AFTER_MS;
}

// Keep only live schedules (reset not long past), newest-armed first, capped.
function prune(schedules: AutoContinueSchedule[], now: number): AutoContinueSchedule[] {
  return schedules
    .filter((s) => !isDeadReset(s.resetAt, now))
    .sort((a, b) => b.armedAt - a.armedAt)
    .slice(0, MAX_SCHEDULES);
}

export function serializeSchedules(data: ScheduleStoreData, now: number): string {
  return JSON.stringify({ version: STORE_VERSION, schedules: prune(data.schedules.filter(isValid), now) });
}

// Parse the on-disk blob → live schedules. Never throws: malformed/legacy/absent
// content yields an empty list (the daemon starts with no armed continues).
export function parseSchedules(blob: string | null, now: number): ScheduleStoreData {
  if (!blob) return { schedules: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return { schedules: [] };
  }
  const raw = (parsed as { schedules?: unknown })?.schedules;
  if (!Array.isArray(raw)) return { schedules: [] };
  return { schedules: prune(raw.filter(isValid), now) };
}

// Upsert one schedule by pane: a pane has at most one pending continue (a new tap
// replaces an older, superseded one for the same pane).
export function upsertSchedule(data: ScheduleStoreData, next: AutoContinueSchedule): ScheduleStoreData {
  return { schedules: [...data.schedules.filter((s) => s.paneId !== next.paneId), next] };
}

export function removeSchedule(data: ScheduleStoreData, paneId: string): ScheduleStoreData {
  return { schedules: data.schedules.filter((s) => s.paneId !== paneId) };
}

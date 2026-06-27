// PURE (de)serialization for the daemon's durable forwarded-question state
// (CtlPaths.questions). The tg-ctl entrypoint owns the file I/O (atomic write +
// readFileOrNull) and the AUTHORITATIVE request normalization
// (normalizeButtonRequest); this module owns only the on-disk FORMAT — the
// versioned envelope, answered-record validation, and age/count pruning. `req` is
// kept un-normalized here (returned as a plain object the entrypoint re-validates)
// so normalizeButtonRequest stays the single source of truth for what a
// ButtonRequest is.
//
// Why persist at all: the daemon held question state ONLY in memory, so a hook
// socket close (the agent's 120s hook budget) or a daemon restart (crash-relaunch
// by launchd, or a deliberate stop+start) lost it — a late Telegram tap was
// dropped and a restart orphaned the human's pending card. Persisting scoped
// questions + the answered-replay cache lets a restored daemon late-deliver a tap
// to the asking pane and re-attach a reconnecting hook instead of posting a
// duplicate card.

import type { PermissionDecision } from './questions';

// One retained question: a LIVE pending OR a socket-closed (abandoned) one — both
// are equivalent on disk, a SCOPED question whose chosen answer can still reach its
// pane. The entrypoint normalizes `req` via normalizeButtonRequest and re-keys by
// callbackRequestId.
export interface RetainedQuestionRecord {
  req: Record<string, unknown>; // a scoped question ButtonRequest (entrypoint re-validates)
  messageId: number | null; // the Telegram card id (edit/answer target)
  at: number; // ms epoch when posted/abandoned (age window + overflow ordering)
}

export interface RetainedAnswerRecord {
  key: string; // callbackRequestId — NOT derivable from value/label, so stored
  value: string;
  label: string;
  decision?: PermissionDecision;
  at: number; // ms epoch when answered (replay-window age)
  // HOW the answer was delivered. `socket` → it went down the hook socket, so a
  // re-fire of the same question REPLAYS it (#98). `pane` → it was late-delivered by
  // injecting into the asking pane, so a reconnecting hook must NOT also replay it
  // (that would deliver twice). Legacy/missing defaults to `socket`.
  delivery: 'socket' | 'pane';
}

export interface QuestionStoreData {
  questions: RetainedQuestionRecord[];
  answered: RetainedAnswerRecord[];
}

const STORE_VERSION = 1;

// Far above any plausible concurrent-question count; bounds the on-disk file on a
// long-lived bot so a flood (or a never-tapped backlog) can't grow it without limit.
// On overflow the FRESHEST entries are kept (most likely to still be tapped). The cap
// is applied at BOTH serialize (so the persisted file is bounded the moment it is
// written, not only after the next restart's parse) and parse (defense in depth on
// read), to BOTH retained questions and the answered-replay cache. The in-memory maps
// the entrypoint holds are bounded by the age-prune it runs before every persist.
//
// Accepted divergence (memory vs disk): this cap bounds the FILE by count, but the
// in-memory maps are bounded only by AGE, not count. In the implausible case of >200
// questions live inside the retention window at once, all stay tappable in memory
// while the daemon runs, yet only the 200 freshest survive a restart (the rest expire
// post-restart). This is accepted because the realistic concurrent-question count on a
// single human's channel is tiny — far below 200; bounding the maps by count too would
// drop a still-deliverable entry from memory before its age window, for no real gain.
export const MAX_RETAINED_QUESTIONS = 200;

// Keep the freshest MAX_RETAINED_QUESTIONS records (newest `at` first). Shared by
// serialize (bound the file on write) and parse (bound on read).
function capByRecency<T extends { at: number }>(records: T[]): T[] {
  return [...records].sort((a, b) => b.at - a.at).slice(0, MAX_RETAINED_QUESTIONS);
}

export function serializeQuestionStore(data: QuestionStoreData): string {
  return JSON.stringify({
    v: STORE_VERSION,
    questions: capByRecency(data.questions),
    answered: capByRecency(data.answered),
  });
}

// Parse + age-filter the on-disk state. The two record kinds get SEPARATE windows
// (`questionMaxAgeMs` for retained questions, `answerMaxAgeMs` for the replay cache)
// so an answered entry isn't restored past its real replay window. Anything
// malformed, an unknown format version, or a too-old entry is skipped — never
// thrown: a corrupt state file degrades to "no restored state", never wedges
// daemon startup.
export function parseQuestionStore(
  raw: string | null,
  now: number,
  questionMaxAgeMs: number,
  answerMaxAgeMs: number,
): QuestionStoreData {
  const empty: QuestionStoreData = { questions: [], answered: [] };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const rec = parsed as Record<string, unknown>;
  // Forward-compat guard: only the version we wrote is understood. A future format
  // bump that this daemon can't read is ignored (no restored state) rather than
  // mis-parsed — the in-memory maps simply start empty.
  if (rec.v !== STORE_VERSION) return empty;
  return {
    questions: parseQuestions(rec.questions, now, questionMaxAgeMs),
    answered: parseAnswered(rec.answered, now, answerMaxAgeMs),
  };
}

function withinWindow(at: unknown, now: number, maxAgeMs: number): at is number {
  return typeof at === 'number' && Number.isFinite(at) && now - at <= maxAgeMs;
}

function parseQuestions(value: unknown, now: number, maxAgeMs: number): RetainedQuestionRecord[] {
  if (!Array.isArray(value)) return [];
  const out: RetainedQuestionRecord[] = [];
  for (const r of value) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (!rec.req || typeof rec.req !== 'object') continue;
    if (!withinWindow(rec.at, now, maxAgeMs)) continue;
    const messageId = typeof rec.messageId === 'number' ? rec.messageId : rec.messageId === null ? null : undefined;
    if (messageId === undefined) continue; // a number|null is required; anything else is corrupt
    out.push({ req: rec.req as Record<string, unknown>, messageId, at: rec.at });
  }
  // Newest first, capped: on overflow keep the freshest (most likely still tappable).
  return capByRecency(out);
}

function parseAnswered(value: unknown, now: number, maxAgeMs: number): RetainedAnswerRecord[] {
  if (!Array.isArray(value)) return [];
  const out: RetainedAnswerRecord[] = [];
  for (const r of value) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.key !== 'string' || !rec.key) continue;
    if (typeof rec.value !== 'string' || typeof rec.label !== 'string') continue;
    if (!withinWindow(rec.at, now, maxAgeMs)) continue;
    const decision = rec.decision === 'allow' || rec.decision === 'deny' ? rec.decision : undefined;
    const delivery = rec.delivery === 'pane' ? 'pane' : 'socket';
    out.push({ key: rec.key, value: rec.value, label: rec.label, decision, at: rec.at, delivery });
  }
  // Same recency cap as questions: a burst of answers inside the replay window can't
  // grow the file (or the in-memory map) without limit.
  return capByRecency(out);
}

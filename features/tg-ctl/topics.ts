// Forum-topics binding store + per-topic lifecycle (docs/specs/tg-forum-topics.md §4, §7).
//
// PURE: the tg-ctl entrypoint owns the file I/O (read/write CtlPaths.topics), the real
// tmux spawn, and the sendMessage; these helpers parse/append/query the plain JSON array
// and compute the next lifecycle state. Tests construct TopicBinding data by hand.
//
// The store mirrors routes.ts: a capped JSON array, one entry per threadId (last write
// wins). The lifecycle is a set of focused transitions — create → path → model → bound,
// plus close/reopen — each returning a NEW binding (no mutation), so a transition is
// trivially unit-testable and the entrypoint just persists the result.

import { findModel } from './models';
import type { TopicBinding, TopicStatus } from './types';

// Far above any real per-chat topic count; keeps the file bounded on a long-lived bot.
export const MAX_TOPICS = 500;

// --- store ---

export function parseTopics(raw: string | null): TopicBinding[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: TopicBinding[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.threadId !== 'number' || !Number.isFinite(rec.threadId)) continue;
    if (typeof rec.status !== 'string' || !isTopicStatus(rec.status)) continue;
    const paneId = typeof rec.paneId === 'string' ? rec.paneId : undefined;
    // A `bound` binding MUST carry a pane — a corrupt/partial file with bound-but-no-pane would
    // make the entrypoint route into nothing. Drop it (it re-binds on the next message) rather
    // than load a binding that claims a live agent it can't reach (review catch).
    if (rec.status === 'bound' && !paneId) continue;
    out.push({
      threadId: rec.threadId,
      name: typeof rec.name === 'string' ? rec.name : '',
      status: rec.status,
      path: typeof rec.path === 'string' ? rec.path : undefined,
      model: typeof rec.model === 'string' ? rec.model : undefined,
      paneId,
      ts: typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : 0,
    });
  }
  return out;
}

function isTopicStatus(s: string): s is TopicStatus {
  return s === 'awaiting-path' || s === 'awaiting-model' || s === 'bound' || s === 'closed';
}

// Upsert by threadId (one binding per topic), newest kept at the tail, capped to MAX_TOPICS.
export function appendTopic(existing: TopicBinding[], binding: TopicBinding): TopicBinding[] {
  const kept = existing.filter((t) => t.threadId !== binding.threadId);
  kept.push(binding);
  return kept.length > MAX_TOPICS ? kept.slice(kept.length - MAX_TOPICS) : kept;
}

export function serializeTopics(topics: TopicBinding[]): string {
  return JSON.stringify(topics, null, 0);
}

export function findTopic(topics: TopicBinding[], threadId: number): TopicBinding | null {
  // Defensive: last entry wins (threadId is unique after appendTopic).
  for (let i = topics.length - 1; i >= 0; i--) {
    if (topics[i].threadId === threadId) return topics[i];
  }
  return null;
}

// --- lifecycle transitions (each returns a NEW binding) ---

// A new forum topic was created → start the /new flow at awaiting-path.
export function createTopic(threadId: number, name: string, ts: number): TopicBinding {
  return { threadId, name, status: 'awaiting-path', ts };
}

// The user supplied a working directory → advance to awaiting-model. Path validity
// (exists + is a dir) is the entrypoint's job; here we only record the chosen path.
export function applyPathAnswer(binding: TopicBinding, path: string, ts: number): TopicBinding {
  return { ...binding, status: 'awaiting-model', path, ts };
}

// The user picked a model → record it so the entrypoint can spawn. Returns null for an
// unknown model id (the caller re-asks rather than launching an ambiguous agent). The
// binding stays awaiting-model until the spawn succeeds (markBound), so a failed spawn
// can retry without losing the path.
export function applyModelAnswer(binding: TopicBinding, modelId: string, ts: number): TopicBinding | null {
  if (!findModel(modelId)) return null;
  return { ...binding, model: modelId, ts };
}

// The spawn succeeded and `paneId` is the new agent's pane → the topic is live.
export function markBound(binding: TopicBinding, paneId: string, ts: number): TopicBinding {
  return { ...binding, status: 'bound', paneId, ts };
}

export function markClosed(binding: TopicBinding, ts: number): TopicBinding {
  return { ...binding, status: 'closed', ts };
}

// A closed topic reopened → drop back into the flow so the next message re-attaches or
// re-spawns. If a path/model are already known we resume at awaiting-model (re-pick model
// → re-spawn); otherwise restart at awaiting-path.
export function markReopened(binding: TopicBinding, ts: number): TopicBinding {
  const status: TopicStatus = binding.path ? 'awaiting-model' : 'awaiting-path';
  return { ...binding, status, paneId: undefined, ts };
}

// --- helpers ---

// True when the topic is mid-/new-flow (the next user message/callback is an answer,
// not a message to inject).
export function isAwaitingAnswer(binding: TopicBinding | null): boolean {
  return binding?.status === 'awaiting-path' || binding?.status === 'awaiting-model';
}

// A safe tmux window name from a topic name: keep word chars + dashes, collapse the rest
// to '-', trim, lowercase, cap length. Empty / all-symbol names fall back to the threadId.
// Lowercase Cyrillic → Latin so a Russian topic name ("Апи бот") yields a READABLE tmux
// window slug ("api-bot") instead of collapsing to `topic-<id>` (review catch — the context is
// Russian, so this is the common case). Mirrors agent-match.ts's transliteration; unmapped
// chars (other scripts, emoji) still fall through to the `topic-<id>` fallback.
const CYRILLIC_SLUG: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function slugifyTopicName(name: string, threadId: number): string {
  // Trim dashes AFTER the length cap — slicing can re-expose a trailing dash if the cut
  // lands exactly on a separator (review catch).
  const slug = name
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => CYRILLIC_SLUG[ch] ?? ch)
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 24)
    .replace(/^-+|-+$/g, '');
  return slug || `topic-${threadId}`;
}

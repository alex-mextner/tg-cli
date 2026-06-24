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
    // pathChoices: only keep a clean string[] (the awaiting-path button candidates). A malformed
    // value degrades to undefined (no choices offered) rather than poisoning the binding.
    const pathChoices =
      Array.isArray(rec.pathChoices) && rec.pathChoices.every((c) => typeof c === 'string')
        ? (rec.pathChoices as string[])
        : undefined;
    out.push({
      threadId: rec.threadId,
      name: typeof rec.name === 'string' ? rec.name : '',
      status: rec.status,
      path: typeof rec.path === 'string' ? rec.path : undefined,
      model: typeof rec.model === 'string' ? rec.model : undefined,
      paneId,
      ts: typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : 0,
      ...(pathChoices ? { pathChoices } : {}),
      ...(typeof rec.pathChoicesNonce === 'number' && Number.isFinite(rec.pathChoicesNonce)
        ? { pathChoicesNonce: rec.pathChoicesNonce }
        : {}),
      ...(rec.respawnOffered === true ? { respawnOffered: true } : {}),
      ...(rec.spawnPending === true ? { spawnPending: true } : {}),
      ...(typeof rec.spawnToken === 'string' && rec.spawnToken.length > 0 ? { spawnToken: rec.spawnToken } : {}),
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
// pathChoices + its nonce are dropped — they were only the awaiting-path button menu, now stale.
export function applyPathAnswer(binding: TopicBinding, path: string, ts: number): TopicBinding {
  const { pathChoices: _drop, pathChoicesNonce: _dropNonce, spawnPending: _sp, spawnToken: _st, ...rest } = binding;
  return { ...rest, status: 'awaiting-model', path, ts };
}

// The user picked a model → record it so the entrypoint can spawn. Returns null for an
// unknown model id (the caller re-asks rather than launching an ambiguous agent). The
// binding stays awaiting-model until the spawn succeeds (markBound), so a failed spawn
// can retry without losing the path.
export function applyModelAnswer(binding: TopicBinding, modelId: string, ts: number): TopicBinding | null {
  if (!findModel(modelId)) return null;
  return { ...binding, model: modelId, ts };
}

// The spawn succeeded and `paneId` is the new agent's pane → the topic is live. Clears the
// re-spawn-offer + spawn-pending + spawn-token fields (a bound topic is neither dead nor mid-spawn).
export function markBound(binding: TopicBinding, paneId: string, ts: number): TopicBinding {
  const { respawnOffered: _ro, spawnPending: _sp, spawnToken: _st, ...rest } = binding;
  return { ...rest, status: 'bound', paneId, ts };
}

// Arm the spawn-pending marker + the per-spawn token IMMEDIATELY before `tmux new-window` (so a
// crash mid-spawn leaves them set → reconcile adopts ONLY a window carrying the matching token);
// the entrypoint clears them on spawn failure. Stays awaiting-model. CLEARS any stale `paneId`
// (codex r14 #2): a closed/retry binding can still carry an OLD pane id — keeping it would let a
// pre-new-window crash leave spawnPending + a stale paneId that reconcile would wrongly accept as
// proof (binding to a reused/stranger pane). The real paneId is set only AFTER new-window returns.
export function markSpawnPending(binding: TopicBinding, token: string, ts: number): TopicBinding {
  const { paneId: _drop, ...rest } = binding;
  return { ...rest, spawnPending: true, spawnToken: token, ts };
}

// Clear the spawn-pending marker + token (spawn FAILED → no orphan window exists; never adopt).
export function clearSpawnPending(binding: TopicBinding, ts: number): TopicBinding {
  const { spawnPending: _sp, spawnToken: _st, ...rest } = binding;
  return { ...rest, ts };
}

// The topic's agent is gone → closed. Drops the re-spawn-offer + spawn-pending + token fields so the
// FIRST message after a fresh close re-offers (respawnOffered is re-set by markRespawnOffered).
export function markClosed(binding: TopicBinding, ts: number): TopicBinding {
  const { respawnOffered: _ro, spawnPending: _sp, spawnToken: _st, ...rest } = binding;
  return { ...rest, status: 'closed', ts };
}

// Record that a re-spawn button was offered for this closed topic (increment 4) so a burst of
// messages to a dead topic doesn't post one offer per message — further messages ack quietly.
export function markRespawnOffered(binding: TopicBinding, ts: number): TopicBinding {
  return { ...binding, respawnOffered: true, ts };
}

// A closed topic reopened → drop back into the flow so the next message re-attaches or
// re-spawns. If a path/model are already known we resume at awaiting-model (re-pick model
// → re-spawn); otherwise restart at awaiting-path. Clears the re-spawn-offer flag.
export function markReopened(binding: TopicBinding, ts: number): TopicBinding {
  const status: TopicStatus = binding.path ? 'awaiting-model' : 'awaiting-path';
  const { respawnOffered: _ro, spawnPending: _sp, spawnToken: _st, ...rest } = binding;
  return { ...rest, status, paneId: undefined, ts };
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

// --- model-pick button (the awaiting-model step of the /new flow) ---

// Callback-data prefix for a model button inside a forum topic. Distinct from the `tgq:`
// (question) and `tga:` (/agent picker) prefixes so the daemon routes a model tap to the
// spawn flow. Shape: `tgm:<threadId>:<modelId>` (modelId is a catalog id like `claude-opus`).
export const TOPIC_MODEL_CALLBACK_PREFIX = 'tgm';

export interface ParsedTopicModelCallback {
  threadId: number;
  modelId: string;
}

// Parse `tgm:<threadId>:<modelId>`. Returns null on any mismatch. The modelId is NOT
// validated against the catalog here (the entrypoint does, re-asking on an unknown id) —
// this only recovers the two routing fields from the button payload.
export function parseTopicModelCallback(data: string | undefined): ParsedTopicModelCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  // Require a POSITIVE-integer threadId. A message_thread_id is always >= 1, so reject `0`/empty
  // (Number('') would coerce to 0 — a valid-looking but wrong binding), `-5`, `1e2`, `0x10`. The
  // `[1-9]\d*` shape rejects a leading-zero / all-zero id outright.
  if (parts.length !== 3 || parts[0] !== TOPIC_MODEL_CALLBACK_PREFIX || !parts[1] || !parts[2]) return null;
  if (!/^[1-9]\d*$/.test(parts[1])) return null;
  const threadId = Number(parts[1]);
  if (!Number.isInteger(threadId)) return null;
  return { threadId, modelId: parts[2] };
}

// The inline keyboard for the awaiting-model prompt: one button per catalog model, the
// callback carrying the threadId + the model's catalog id. PURE — the entrypoint posts it
// with sendMessage(reply_markup). Returned as the Bot API `inline_keyboard` shape (rows of
// one button) so the entrypoint hands it straight through.
export function buildModelKeyboard(
  threadId: number,
  catalog: ReadonlyArray<{ id: string; label: string }>,
): Array<Array<{ text: string; callback_data: string }>> {
  return catalog.map((m) => [
    { text: m.label, callback_data: `${TOPIC_MODEL_CALLBACK_PREFIX}:${threadId}:${m.id}` },
  ]);
}

// --- recent-repo path buttons (the awaiting-path step of the /new flow, increment 4) ---

// How many recent-path buttons to offer at most. Telegram caps an inline keyboard generously,
// but a long menu is noise — the top few recent repos cover the common case; the free-text
// fallback always remains for anything else.
export const MAX_PATH_CHOICES = 8;

// Callback-data prefix for a recent-path button. Distinct from `tgm:` (model) so the daemon
// routes a path tap to the awaiting-path step. Shape: `tgp:<threadId>:<index>:<nonce>` — the
// index is into the binding's persisted `pathChoices` (callback_data is 64 bytes, too small for a
// path), and the NONCE pins the tap to the SPECIFIC prompt that offered those choices. Without it,
// an OLD prompt's button (after a setup restart replaced pathChoices) would resolve its index
// against the NEW list and silently pick the wrong directory (codex r3 P1). The entrypoint rejects
// a tap whose nonce != the binding's current pathChoicesNonce.
export const TOPIC_PATH_CALLBACK_PREFIX = 'tgp';

export interface ParsedTopicPathCallback {
  threadId: number;
  index: number;
  nonce: number;
}

// Parse `tgp:<threadId>:<index>:<nonce>`. Returns null on any mismatch. The index + nonce are
// validated against the binding by the entrypoint (a stale/forged index or nonce re-asks); here we
// only recover the integer fields. threadId mirrors the model-callback strictness (positive int).
export function parseTopicPathCallback(data: string | undefined): ParsedTopicPathCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 4 || parts[0] !== TOPIC_PATH_CALLBACK_PREFIX || !parts[1] || !parts[2] || !parts[3]) return null;
  if (!/^[1-9]\d*$/.test(parts[1])) return null;
  // Index is a NON-negative integer (0-based into pathChoices). `0` is valid here, so the
  // threadId's `[1-9]\d*` shape does not apply — use the (0|[1-9]\d*) shape to reject leading-zero.
  if (!/^(0|[1-9]\d*)$/.test(parts[2])) return null;
  // Nonce is a positive integer (a binding ts, always >= 1) — leading-zero / zero rejected.
  if (!/^[1-9]\d*$/.test(parts[3])) return null;
  return { threadId: Number(parts[1]), index: Number(parts[2]), nonce: Number(parts[3]) };
}

// Pick the recent project paths to offer as awaiting-path buttons, most-recent first, deduped,
// capped to MAX_PATH_CHOICES. PURE: the entrypoint passes the candidate cwds (from the routes
// store + the per-pane registrations, newest first) and this filters to absolute, currently-
// existing directories via the injected `isDir` probe so a button never points at a vanished or
// relative path (the spawn requires an absolute existing dir — offering anything else is a trap).
export function recentPathChoices(
  candidates: ReadonlyArray<string | undefined>,
  isAbsoluteDir: (p: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (typeof c !== 'string' || c.length === 0) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    if (!isAbsoluteDir(c)) continue;
    out.push(c);
    if (out.length >= MAX_PATH_CHOICES) break;
  }
  return out;
}

// The inline keyboard for the awaiting-path prompt: one button per recent path (callback
// `tgp:<threadId>:<index>:<nonce>`), one path per row so a long path stays readable. The `nonce`
// (the offering binding's ts) pins each button to THIS prompt's choice list, so a stale button
// from a superseded prompt is rejected rather than mis-resolved (codex r3 P1). PURE — empty when
// there are no choices (the entrypoint then posts the prompt without a keyboard, free-text only).
export function buildPathKeyboard(
  threadId: number,
  choices: ReadonlyArray<string>,
  nonce: number,
): Array<Array<{ text: string; callback_data: string }>> {
  return choices.map((p, i) => [
    { text: p, callback_data: `${TOPIC_PATH_CALLBACK_PREFIX}:${threadId}:${i}:${nonce}` },
  ]);
}

// --- re-spawn button (a message to a dead/closed topic, increment 4) ---

// Callback-data prefix for a re-spawn button offered when a topic's bound pane is dead. The
// retained path + model are re-used, so no payload beyond the threadId is needed. Shape:
// `tgr:<threadId>`.
export const TOPIC_RESPAWN_CALLBACK_PREFIX = 'tgr';

// Parse `tgr:<threadId>` → the threadId, or null on mismatch (same positive-int strictness).
export function parseTopicRespawnCallback(data: string | undefined): number | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 2 || parts[0] !== TOPIC_RESPAWN_CALLBACK_PREFIX || !parts[1]) return null;
  if (!/^[1-9]\d*$/.test(parts[1])) return null;
  return Number(parts[1]);
}

// The one-button "Re-spawn" keyboard for a dead topic. Offered only when the binding retains a
// path + model (a full re-spawn is possible); otherwise the entrypoint re-enters the /new flow.
export function buildRespawnKeyboard(
  threadId: number,
): Array<Array<{ text: string; callback_data: string }>> {
  return [[{ text: 'Re-spawn the agent', callback_data: `${TOPIC_RESPAWN_CALLBACK_PREFIX}:${threadId}` }]];
}

// `/next <ticket-id>` bot command — a Telegram-facing "what's the real state of this ticket"
// card: pm-cli's ticket-lifecycle state (`pm why <id> --json`, pm-cli#16/#18) plus the
// project's live git status (mirrors git-state.ts / tg-ctl's gitStateForPath) plus a PR/CI
// rollup (reuses tasks-command.ts's gh-derived types and glyphs).
//
// This replaces hyperide's old, confirmed-dead `/state` and `/next` slash-command runbooks —
// those cached ticket state into a local file, updated by a hook that was PLANNED but never
// actually wired up (`.claude/settings.json` never registered it), so the cache silently rotted
// the moment it was written. There is deliberately NO local state file here: every field in the
// card is computed FRESH, on every query, from already-durable sources (pm-cli's event log, a
// live `git status`, a live `gh pr list`) — nothing to rot.
//
// PURE, like tasks-command.ts: this module owns arg parsing, the pm-work-item-id resolution
// heuristic, and the rich-HTML card composition. The daemon (tg-ctl) owns the spawns (pm, git,
// gh) and the sendRich call.
//
// Each data source can fail INDEPENDENTLY without blanking the whole card: `pm why` is the one
// REQUIRED source (no ticket state, no card). Git status and PR/CI are best-effort sections
// that render an explicit "—" placeholder line instead of disappearing silently or fabricating
// a value — the same no-fabrication rule tasks-command.ts follows for its table cells.

import { escapeHtml } from '../render/html';
import { ciGlyph, escapeRegExp, reviewGlyph, type PrRef } from './tasks-command';
import type { PaneGitState } from './git-state';

// The usage text sent when `/next` is called with no ticket id.
export const NEXT_USAGE_TEXT = 'usage: /next <ticket-id>';

// Parse `/next <ticket-id>`. Returns null when no ticket id was given — updates.ts still emits a
// 'next' Action (ticketId: '') in that case, so the daemon can reply with NEXT_USAGE_TEXT using
// the SAME thread/reply context a real lookup would use (tg-cli#289 review catch: a context-free
// reply to a missing-id `/next` inside a bound forum topic landed in General instead).
export function parseNextCommand(text: string): { ticketId: string } | null {
  const args = text
    .trim()
    .replace(/^\/next(@\w+)?/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const ticketId = args[0];
  return ticketId ? { ticketId } : null;
}

// --- pm why --json's shape (pm-cli PR #18, pmlib/commands/why.py `_to_json`) ---

export interface PmWhyEvidence {
  kind: string;
  uri: string;
  observed_at: string;
}

export interface PmWhyNextMove {
  state: string;
  missing_evidence: string[];
}

export interface PmWhyNext {
  terminal: boolean;
  unknown_state: boolean;
  moves: PmWhyNextMove[];
}

// A subset of `WorkItem.to_dict()` + `pm_labels`/`next` (pm-cli's why.py `_to_json`). Extra
// fields (task_refs, intake_refs, dependencies, timers, created_at, updated_at, ...) are ignored
// — this module only reads what the card renders.
export interface PmWhyJson {
  id: string;
  title: string;
  state: string;
  project?: string;
  pm_labels: string[];
  evidence: PmWhyEvidence[];
  errors: string[];
  next: PmWhyNext;
}

// Parse + validate `pm why <id> --json`'s stdout. Throws on invalid JSON OR a shape that doesn't
// match PmWhyJson closely enough for composeNextCard to safely dereference (review catch,
// tg-cli#289 P1): an unvalidated cast let a version-drifted or truncated payload — `{}`, `null`,
// a `pm` build that renamed a field — reach `item.evidence.find(...)` / `item.next.moves` and
// throw INSIDE the daemon's action-processing loop, which aborts every action still queued behind
// it in that poll batch (the offset was already persisted, so those updates are silently lost).
// The daemon's caller wraps this in the same try/catch that already handles a JSON.parse failure,
// so a shape mismatch degrades exactly like one — `reason: 'error'` — never a lost batch.
export function parsePmWhyJson(raw: string): PmWhyJson {
  const data: unknown = JSON.parse(raw);
  if (!isPmWhyJson(data)) throw new Error('pm why --json: response does not match the expected shape');
  return data;
}

// Validates every field either composeNextCard (the renderer) OR the daemon (resolveNextScopeDir
// feeds `project` to matchWindows BEFORE rendering) dereferences — a field checked only for
// "the renderer's sake" reopens the exact batch-abort hole this validator exists to close, just
// one call earlier (review catch, tg-cli#289 round 2: `project` and `missing_evidence` elements
// were missed on the first pass).
function isPmWhyJson(x: unknown): x is PmWhyJson {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.state === 'string' &&
    (o.project === undefined || typeof o.project === 'string') &&
    Array.isArray(o.pm_labels) &&
    o.pm_labels.every((l) => typeof l === 'string') &&
    Array.isArray(o.evidence) &&
    o.evidence.every(isPmWhyEvidence) &&
    Array.isArray(o.errors) &&
    o.errors.every((e) => typeof e === 'string') &&
    isPmWhyNext(o.next)
  );
}

function isPmWhyEvidence(x: unknown): x is PmWhyEvidence {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.kind === 'string' && typeof o.uri === 'string';
}

function isPmWhyNext(x: unknown): x is PmWhyNext {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.terminal === 'boolean' && typeof o.unknown_state === 'boolean' && Array.isArray(o.moves) && o.moves.every(isPmWhyNextMove);
}

function isPmWhyNextMove(x: unknown): x is PmWhyNextMove {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.state === 'string' && Array.isArray(o.missing_evidence) && o.missing_evidence.every((e) => typeof e === 'string');
}

// `pm why <id> --json` exits 2 for BOTH "no such work item" (pmlib/commands/why.py) AND
// argparse's generic "unrecognized arguments" — which is exactly what a `pm` binary predating
// the --json flag (pm-cli#18) prints for ANY id, tracked or not (verified live: `pm why <id>
// --json` against pm-cli main exits 2 with "pm: error: unrecognized arguments: --json"). Treating
// every exit-2 as "not tracked" would report a confident false "no pm work item found" for every
// ticket whenever the live `pm` checkout sits on a branch/version without the flag — exactly the
// silent-rot failure mode this command exists to replace. Only classify as 'not-found' when the
// stderr text actually says so; anything else (including a stale `pm`) is a real 'error'.
export function classifyPmWhyFailure(exitCode: number, stderr: string): 'not-found' | 'error' {
  return exitCode === 2 && /no work item/i.test(stderr) ? 'not-found' : 'error';
}

// Candidate pm work-item ids to try `pm why <id> --json` against, in order, for a bare
// ticket-id the user typed (e.g. "HYP-1033" or "#16"). pm-cli's task-ingest adapter mints ids as
// `task:<ref>` where ref is `<project>:<ticket-id>` when a project is known, else the bare
// ticket-id (pmlib/adapters/task.py `_task_ref`) — so a raw "HYP-1033" needs the project prefix
// GUESSED from its own `<PREFIX>-<N>` shape before `task:<ref>` will resolve it. The daemon
// tries these in order and stops at the first `pm why` that succeeds; a manually-created pm item
// (id "w1", no task-cli ticket behind it) is covered by the as-typed candidate.
export function candidatePmIds(rawTicketId: string): string[] {
  const id = rawTicketId.trim().replace(/^#/, '');
  const out: string[] = [];
  const add = (candidate: string): void => {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  };
  add(id); // already a full pm id ("task:HYP:HYP-1033"), or a manually-created bare id ("w1")
  if (!id.startsWith('task:')) add(`task:${id}`); // ingested with no project qualifier
  const projectMatch = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(id);
  if (projectMatch) add(`task:${projectMatch[1].toUpperCase()}:${id}`);
  return out;
}

// Find the PR that references `ticketId` in its title/body. Deliberately NOT matchPrsToTasks
// (tasks-command.ts): that helper assumes GitHub-issue-shaped ids ("#117") anchored with a `#`.
// A Linear-style ref ("HYP-1033") is written as plain text in a PR body, never `#HYP-1033` — so
// a purely numeric id still gets the `#`-anchored match (fewer false positives on a bare
// number), while anything else matches the literal ref text with an EXPLICIT token boundary.
//
// Plain `\b` is NOT enough here (review catch, tg-cli#289 round 2): `-` is a non-word character,
// so `\bHYP-1033\b` treats the '-' right after "1033" as itself satisfying the trailing boundary
// — `HYP-1033` then falsely matches inside a longer compound like "HYP-1033-follow-up" (a
// plausible real PR title, ticket-id-as-slug). A Linear-style ticket token spans
// `[A-Za-z0-9-]` — the boundary must reject an adjacent char from THAT set, not just `\w`.
export function findMatchingPr(ticketId: string, prs: PrRef[]): PrRef | null {
  const raw = ticketId.trim().replace(/^#/, '');
  if (!raw) return null;
  const isNumeric = /^\d+$/.test(raw);
  const escaped = escapeRegExp(raw);
  const notInToken = '(?![A-Za-z0-9-])';
  const pattern = isNumeric ? `#${escaped}${notInToken}` : `(?<![A-Za-z0-9-])${escaped}${notInToken}`;
  const re = new RegExp(pattern, 'i');
  const matches = prs.filter((pr) => re.test(`${pr.title}\n${pr.body ?? ''}`));
  if (matches.length === 0) return null;
  return matches.reduce((best, pr) => (pr.number > best.number ? pr : best));
}

// --- per-source results (each can fail independently — see module header) ---

export type NextWhyResult = { ok: true; data: PmWhyJson } | { ok: false; reason: 'not-found' | 'error' };

export type NextGitResult = { ok: true; state: PaneGitState } | { ok: false; reason: 'no-scope' | 'unavailable' };

// pr: null means "gh ran fine, no PR referenced this ticket" — a GENUINE absence, kept distinct
// from `ok: false, reason: 'unavailable'` (gh missing/timed out/auth failure/bad JSON). Collapsing
// the two would fabricate an absence result for a failed lookup (review catch, tg-cli#289 P2) —
// the daemon must know whether `gh` actually ran before it can say "no matching PR found".
export type NextPrResult = { ok: true; pr: PrRef | null } | { ok: false; reason: 'no-scope' | 'unavailable' };

export interface NextCardInput {
  ticketId: string; // as typed by the user, for the header/error text
  why: NextWhyResult;
  git: NextGitResult;
  pr: NextPrResult;
}

export function composeNextCard(input: NextCardInput): string {
  if (!input.why.ok) return `<p>${notFoundLine(input.ticketId, input.why.reason)}</p>`;
  const item = input.why.data;
  const lines = [headerLine(item), stateLine(item), nextMovesLine(item.next), gitStatusLine(input.git), prCiLine(input.pr)];
  if (item.errors.length > 0) lines.push(errorsLine(item.errors));
  return `<p>${lines.join('<br>')}</p>`;
}

function notFoundLine(ticketId: string, reason: 'not-found' | 'error'): string {
  const id = escapeHtml(ticketId);
  return reason === 'not-found' ? `no pm work item found for <b>${id}</b>` : `couldn't look up <b>${id}</b> — pm why failed`;
}

function headerLine(item: PmWhyJson): string {
  const link = item.evidence.find((e) => e.kind === 'task-record')?.uri;
  const label = `${escapeHtml(item.id)} — ${escapeHtml(item.title)}`;
  return `<b>${link ? `<a href="${escapeHtml(link)}">${label}</a>` : label}</b>`;
}

function stateLine(item: PmWhyJson): string {
  const labels = item.pm_labels.length > 0 ? item.pm_labels.map(escapeHtml).join(', ') : '—';
  return `state: <b>${escapeHtml(item.state)}</b>  (${labels})`;
}

function nextMovesLine(next: PmWhyNext): string {
  if (next.unknown_state) return 'next: ⚠ unknown state — not in the machine';
  if (next.terminal) return 'next: terminal — no further moves';
  if (next.moves.length === 0) return 'next: —';
  const parts = next.moves.map((m) =>
    m.missing_evidence.length > 0 ? `${escapeHtml(m.state)} (needs ${m.missing_evidence.map(escapeHtml).join(', ')})` : escapeHtml(m.state),
  );
  return `next: ${parts.join(', ')}`;
}

function gitStatusLine(git: NextGitResult): string {
  if (!git.ok) return git.reason === 'no-scope' ? 'git: — (no project scope resolved)' : 'git: — (unavailable)';
  const branch = git.state.branch || 'detached HEAD';
  const dirty = git.state.uncommittedCount > 0 ? `${git.state.uncommittedCount} file${git.state.uncommittedCount === 1 ? '' : 's'} changed` : 'clean';
  return `git: ${escapeHtml(branch)} (${dirty})`;
}

function prCiLine(pr: NextPrResult): string {
  if (!pr.ok) return pr.reason === 'no-scope' ? 'PR/CI: — (no project scope resolved)' : 'PR/CI: — (gh unavailable)';
  if (!pr.pr) return 'PR/CI: — (no matching PR found)';
  const p = pr.pr;
  return `PR: <a href="${escapeHtml(p.url)}">#${p.number}</a>  CI ${ciGlyph(p.ci)}  Review ${reviewGlyph(p.review ?? null)}`;
}

function errorsLine(errors: string[]): string {
  return `⚠ ${errors.map(escapeHtml).join('; ')}`;
}

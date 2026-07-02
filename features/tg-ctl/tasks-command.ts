// `/tasks [<agent>] [<status>]` bot command (tg-cli#115).
//
// Alex (tg#5698) wants the task board on his phone: a table of tickets with
// lifecycle status, filterable by agent window and status, composed from
// `task list --json` plus the PR/CI state `gh pr list --json` carries. This
// module is PURE — arg parsing, status normalization, PR↔ticket matching, CI
// rollup, and the rich-HTML table composition. The daemon owns the spawns
// (task-cli, gh), the fuzzy agent→project scope (agent-match.ts), and the
// sendRichMessage call.
//
// Missing data (no PR, no CI, no due date) renders as an explicit em dash — it
// is NEVER fabricated (a fabricated "passing" CI would be worse than a blank).

import { escapeHtml } from '../render/html';

// task-cli's canonical states. `/tasks <status>` filters on one of these; a range
// of natural aliases normalizes onto them so `/tasks wip` or `/tasks review` work.
export const TASK_STATES = ['todo', 'in-progress', 'in-review', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

const STATUS_ALIASES: Readonly<Record<string, TaskState>> = {
  todo: 'todo', open: 'todo', backlog: 'todo', new: 'todo',
  'in-progress': 'in-progress', inprogress: 'in-progress', in_progress: 'in-progress',
  progress: 'in-progress', wip: 'in-progress', doing: 'in-progress', active: 'in-progress',
  'in-review': 'in-review', inreview: 'in-review', in_review: 'in-review',
  review: 'in-review', reviewing: 'in-review',
  done: 'done', closed: 'done', complete: 'done', completed: 'done', finished: 'done',
  cancelled: 'cancelled', canceled: 'cancelled', cancel: 'cancelled', wontfix: 'cancelled', dropped: 'cancelled',
};

// A status token → its canonical task-cli state, or null when it is not a status
// (so the daemon can treat it as an agent selector instead).
export function normalizeTaskStatus(token: string): TaskState | null {
  return STATUS_ALIASES[token.trim().toLowerCase()] ?? null;
}

export interface ParsedTasksCommand {
  agent: string | null; // fuzzy agent-window selector (daemon resolves → project dir)
  status: TaskState | null; // normalized state filter
}

// What the table header/label renders — the resolved scope. Widened to a plain
// string status so the daemon's Action (a string) composes without a cast; the
// value is display-only (escaped), never re-parsed.
export interface TasksScope {
  agent: string | null;
  status: string | null;
}

// Parse `/tasks [<agent>] [<status>]`. Order-tolerant: whichever token
// normalizes to a status IS the status, the other is the agent. So `/tasks done`,
// `/tasks hyperide`, `/tasks hyperide done`, and `/tasks done hyperide` all work.
export function parseTasksCommand(text: string): ParsedTasksCommand {
  const args = text
    .trim()
    .replace(/^\/tasks(@\w+)?/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let agent: string | null = null;
  let status: TaskState | null = null;
  for (const arg of args) {
    const asStatus = normalizeTaskStatus(arg);
    if (asStatus && !status) status = asStatus;
    else if (!agent) agent = arg;
  }
  return { agent, status };
}

// A ticket as `task list --json` emits it (extra fields are ignored).
export interface TaskItem {
  id: string; // "#117"
  title: string;
  state: string;
  url?: string;
  due?: string;
}

// A PR as `gh pr list --json number,title,url,body,state,statusCheckRollup`
// emits it, after the daemon normalizes the CI rollup to a verdict.
export interface PrRef {
  number: number;
  url: string;
  title: string;
  body?: string;
  ci: CiState;
}

export type CiState = 'pass' | 'fail' | 'pending' | null;

// Reduce a gh statusCheckRollup array to one verdict. Any failure → fail; any
// still-running/queued → pending; all successful/neutral/skipped → pass; empty
// or unknown → null (rendered as a dash, never a fabricated "pass").
export function rollupCiState(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let sawPending = false;
  let sawPass = false;
  for (const check of rollup) {
    const c = check as { status?: string; conclusion?: string; state?: string };
    const status = (c.status ?? '').toUpperCase();
    const verdict = (c.conclusion ?? c.state ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') {
      sawPending = true;
      continue;
    }
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(verdict)) return 'fail';
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)) sawPass = true;
    else if (verdict === '' || ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(verdict)) sawPending = true;
  }
  if (sawPending) return 'pending';
  return sawPass ? 'pass' : null;
}

// Match each ticket to the most relevant PR that references it (the ticket's
// `#<n>` appears as a whole token in the PR title or body). On multiple matches
// the highest PR number (most recent) wins. Returns a map keyed by ticket id.
export function matchPrsToTasks(tasks: TaskItem[], prs: PrRef[]): Map<string, PrRef> {
  const out = new Map<string, PrRef>();
  for (const task of tasks) {
    const num = task.id.replace(/^#/, '');
    if (!num) continue;
    // The id comes from `task list --json` output — escape regex metacharacters
    // so a non-numeric / odd id (e.g. a `+`/`(`/`[`) can't corrupt the match or
    // throw an uncaught RegExp error in the daemon.
    const re = new RegExp(`#${escapeRegExp(num)}\\b`);
    const matches = prs.filter((pr) => re.test(pr.title) || (pr.body ? re.test(pr.body) : false));
    if (matches.length === 0) continue;
    out.set(task.id, matches.reduce((best, pr) => (pr.number > best.number ? pr : best)));
  }
  return out;
}

const CI_GLYPH: Readonly<Record<Exclude<CiState, null>, string>> = { pass: '✓', fail: '✗', pending: '…' };

// The scope line above the table (what the filters resolved to), for context.
export function tasksScopeLabel(scope: TasksScope): string {
  const parts: string[] = [];
  if (scope.agent) parts.push(`agent <b>${escapeHtml(scope.agent)}</b>`);
  if (scope.status) parts.push(`status <b>${escapeHtml(scope.status)}</b>`);
  return parts.length ? `Tasks — ${parts.join(', ')}` : 'Tasks';
}

// Compose the rich-HTML table (Bot API sendRichMessage). One header row + a row
// per task: id (linked), title (truncated), state, due, PR (linked), CI. Every
// absent field is an em dash. Returns a <p>scope</p> + <table> body.
export function composeTasksTable(tasks: TaskItem[], prsByTask: Map<string, PrRef>, scope: TasksScope): string {
  const label = tasksScopeLabel(scope);
  if (tasks.length === 0) return `<p>${label}</p><p>No matching tasks.</p>`;
  const header = '<tr><th>ID</th><th>Title</th><th>State</th><th>Due</th><th>PR</th><th>CI</th></tr>';
  const rows = tasks.map((t) => taskRow(t, prsByTask.get(t.id) ?? null)).join('');
  return `<p>${label}</p><table>${header}${rows}</table>`;
}

function taskRow(t: TaskItem, pr: PrRef | null): string {
  const id = t.url ? `<a href="${escapeHtml(t.url)}">${escapeHtml(t.id)}</a>` : escapeHtml(t.id);
  const title = escapeHtml(truncate(t.title, 60));
  const state = escapeHtml(t.state || '—');
  const due = t.due ? escapeHtml(t.due) : '—';
  const prCell = pr ? `<a href="${escapeHtml(pr.url)}">#${pr.number}</a>` : '—';
  const ci = pr && pr.ci ? CI_GLYPH[pr.ci] : '—';
  return `<tr><td>${id}</td><td>${title}</td><td>${state}</td><td>${due}</td><td>${prCell}</td><td>${ci}</td></tr>`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// /tasks [<agent>] [<status>] — the task-table bot command (tg-cli#115).
//
// Composes `task list --json` (task-cli) + `gh pr list --json` into one rich
// HTML `<table>` the daemon sends via sendRichMessage, so the operator sees the
// board — ticket state, linked PR, CI verdict — from the phone without a
// terminal. Missing data renders as a dash, NEVER fabricated: a ticket with no
// referencing PR gets an empty PR/CI cell, a gh failure dashes the whole column
// (the entrypoint adds a footnote).
//
// PURE — no I/O. The tg-ctl entrypoint owns the spawns (`task`, `gh`), the
// agent-window fuzzy match (agent-match.ts) and the send; these helpers turn
// plain data into the reply. Tests construct the same data by hand.

import { escapeHtml } from '../render/html';

// --- shapes mirrored from the external CLIs (only the fields we read) ---

// One ticket as `task list --json` emits it (task-cli, github-issues/linear).
export interface TaskTicket {
  id: string; // "#106" (github) or "HYP-42" (linear)
  title: string;
  state: string; // normalized task-cli state: todo|in-progress|in-review|done|cancelled
  url: string;
  labels: string[];
  what: string;
  due: string; // "YYYY-MM-DD" or ""
}

// One project block of `task list --all --json`.
export interface TaskProject {
  project: string; // "owner/repo" (github) or a Linear team key
  backend: string; // "github-issues" | "linear"
  current: boolean;
  error: string | null;
  tickets: TaskTicket[];
}

// One PR as `gh pr list --json number,title,body,state,isDraft,reviewDecision,statusCheckRollup,url` emits it.
export interface PrInfo {
  number: number;
  title: string;
  body: string;
  state: string; // OPEN | MERGED | CLOSED
  isDraft: boolean;
  reviewDecision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  statusCheckRollup: unknown; // array of CheckRun/StatusContext nodes (shape varies)
  url: string;
}

// --- task-cli output normalization ---

function asTicket(value: unknown): TaskTicket | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string' || typeof r.state !== 'string') return null;
  return {
    id: r.id,
    title: r.title,
    state: r.state,
    url: typeof r.url === 'string' ? r.url : '',
    labels: Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === 'string') : [],
    what: typeof r.what === 'string' ? r.what : '',
    due: typeof r.due === 'string' ? r.due : '',
  };
}

// "https://github.com/o/r/issues/7" → "o/r"; anything else → null.
function projectFromTicketUrl(url: string): string | null {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\//);
  return m ? m[1] : null;
}

// `task list --all --json` emits project blocks ({project, backend, error,
// tickets}); `task list -C <dir> --json` emits a FLAT ticket array for that one
// repo. Fold both into TaskProject[]; the flat shape derives its project key
// (owner/repo, needed for the gh PR lookup) from the ticket URLs. Returns null
// on unrecognizable JSON — the entrypoint reports the failure instead of
// rendering an empty board that would read as "no tasks".
export function normalizeTaskListJson(parsed: unknown): TaskProject[] | null {
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return [];
  // Grouped detection must not hinge on the FIRST block being healthy: a
  // failed project (error set, no tickets array) can lead the array, and
  // misreading that as the flat shape would reject the whole valid response.
  // Any block that looks like a project block ⇒ grouped (review r3).
  const looksGrouped = parsed.some((b) => {
    if (!b || typeof b !== 'object') return false;
    const r = b as Record<string, unknown>;
    return Array.isArray(r.tickets) || (typeof r.project === 'string' && typeof r.backend === 'string');
  });
  if (looksGrouped) {
    // Project-grouped shape.
    const out: TaskProject[] = [];
    for (const block of parsed) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      out.push({
        project: typeof b.project === 'string' ? b.project : '',
        backend: typeof b.backend === 'string' ? b.backend : '',
        current: b.current === true,
        error: typeof b.error === 'string' ? b.error : null,
        tickets: Array.isArray(b.tickets) ? b.tickets.map(asTicket).filter((t): t is TaskTicket => t !== null) : [],
      });
    }
    return out;
  }
  // Flat ticket-array shape (scoped `task list -C <dir>`).
  const tickets = parsed.map(asTicket).filter((t): t is TaskTicket => t !== null);
  if (tickets.length === 0 && parsed.length > 0) return null; // array of junk, not tickets
  const project = tickets.map((t) => projectFromTicketUrl(t.url)).find((p) => p !== null) ?? '';
  const backend = project ? 'github-issues' : '';
  return [{ project, backend, current: true, error: null, tickets }];
}

// --- command parse ---

export interface ParsedTasksCommand {
  agent: string | null; // fuzzy window selector, resolved by the entrypoint
  status: string | null; // normalized state, or 'all'; null = default (open states)
  // Human-readable parse problem ("unknown status: …"). The entrypoint replies
  // with it verbatim instead of guessing what the operator meant.
  error: string | null;
}

// Status aliases the command accepts → the normalized task-cli state (or 'all').
// Mirrors task-cli's own State.parse alias table so `/tasks doing` and
// `task list --state doing` agree on what "doing" means.
const STATUS_ALIASES: Record<string, string> = {
  todo: 'todo',
  open: 'todo',
  backlog: 'todo',
  'in-progress': 'in-progress',
  inprogress: 'in-progress',
  doing: 'in-progress',
  started: 'in-progress',
  'in-review': 'in-review',
  inreview: 'in-review',
  review: 'in-review',
  done: 'done',
  closed: 'done',
  finished: 'done',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  all: 'all',
};

// The default scope: live work only. `done`/`cancelled`/`all` must be asked for.
export const OPEN_STATES: ReadonlySet<string> = new Set(['todo', 'in-progress', 'in-review']);

export function normalizeStatus(token: string): string | null {
  const norm = token.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  return STATUS_ALIASES[norm] ?? null;
}

// `/tasks` → all agents, open states. `/tasks done` → status filter (a lone arg
// that parses as a status is a status, per the [<agent>] [<status>] grammar).
// `/tasks rig` → agent selector. `/tasks rig done` → both. A second arg that is
// not a recognizable status is a parse error, never silently ignored.
export function parseTasksCommand(text: string): ParsedTasksCommand {
  const body = text.replace(/^\/tasks(@\w+)?\s*/i, '').trim();
  if (!body) return { agent: null, status: null, error: null };
  const parts = body.split(/\s+/);
  if (parts.length === 1) {
    const status = normalizeStatus(parts[0]);
    if (status) return { agent: null, status, error: null };
    return { agent: parts[0], status: null, error: null };
  }
  if (parts.length === 2) {
    const status = normalizeStatus(parts[1]);
    if (!status) {
      return {
        agent: null,
        status: null,
        error: `unknown status '${parts[1]}' — known: todo, in-progress, in-review, done, cancelled, all`,
      };
    }
    return { agent: parts[0], status, error: null };
  }
  return { agent: null, status: null, error: 'usage: /tasks [<agent>] [<status>]' };
}

// --- ticket ↔ PR linkage ---

// The numeric part of a github-issues ticket id ("#106" → 106). Linear ids
// (HYP-42) have no `#N` cross-reference convention in PR bodies → null.
export function ticketNumberOf(id: string): number | null {
  const m = id.match(/^#(\d+)$/);
  return m ? Number(m[1]) : null;
}

// A PR references ticket #N when its title or body contains `#N` as a whole
// token (word-boundary on both sides; `#1066` must not match ticket #106), or
// the explicit same-repo `owner/repo#N` form when `project` is known (review
// r3 — the bare-`#` guard would otherwise reject it; an OTHER repo's
// `o/other#N` still never matches). GitHub PRs and issues share one number
// space, so a PR whose OWN number equals the ticket's is skipped — `#N` inside
// PR #N is a self-reference, not a link.
export function prReferencesTicket(pr: PrInfo, ticketNumber: number, project?: string): boolean {
  if (pr.number === ticketNumber) return false;
  const res = [new RegExp(`(^|[^\\w&])#${ticketNumber}\\b`)];
  if (project && /^[\w.-]+\/[\w.-]+$/.test(project)) {
    const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    res.push(new RegExp(`(^|[^\\w&])${escaped}#${ticketNumber}\\b`));
  }
  return res.some((re) => re.test(pr.title) || re.test(pr.body));
}

// PR-state rank for picking the ONE PR shown in a ticket's cell: a live open PR
// beats a merged one beats a closed one; within a state the newest (highest
// number) wins.
function prRank(pr: PrInfo): number {
  if (pr.state === 'OPEN') return 0;
  if (pr.state === 'MERGED') return 1;
  return 2;
}

// Map each ticket number to the best PR referencing it. Tickets nobody
// references get no entry (the cell stays a dash — never guess). `project`
// (owner/repo) additionally recognizes the explicit `owner/repo#N` ref form.
export function linkPrsToTickets(tickets: TaskTicket[], prs: PrInfo[], project?: string): Map<number, PrInfo> {
  const out = new Map<number, PrInfo>();
  for (const t of tickets) {
    const n = ticketNumberOf(t.id);
    if (n === null) continue;
    const refs = prs.filter((pr) => prReferencesTicket(pr, n, project));
    if (refs.length === 0) continue;
    refs.sort((a, b) => prRank(a) - prRank(b) || b.number - a.number);
    out.set(n, refs[0]);
  }
  return out;
}

// Normalize one `gh pr list --json` element, tolerant like asTicket: a PR with
// `body: null` (no description) or missing optional fields must not poison the
// linkage regexes or the render (review r3 — no unchecked casts of gh output).
export function asPrInfo(value: unknown): PrInfo | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.number !== 'number') return null;
  return {
    number: r.number,
    title: typeof r.title === 'string' ? r.title : '',
    body: typeof r.body === 'string' ? r.body : '',
    state: typeof r.state === 'string' ? r.state : '',
    isDraft: r.isDraft === true,
    reviewDecision: typeof r.reviewDecision === 'string' ? r.reviewDecision : '',
    statusCheckRollup: r.statusCheckRollup,
    url: typeof r.url === 'string' ? r.url : '',
  };
}

// --- CI verdict ---

export type CiState = 'pass' | 'fail' | 'pending' | null;

// Fold gh's statusCheckRollup array (a mix of CheckRun nodes — status +
// conclusion — and StatusContext nodes — state) into one verdict: any failure
// wins, else any still-running check → pending, else all-green → pass. An empty
// or unrecognizable rollup is null (no CI wired), rendered as a dash.
export function ciStateOf(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let sawPass = false;
  let sawPending = false;
  for (const node of rollup) {
    if (!node || typeof node !== 'object') continue;
    const n = node as Record<string, unknown>;
    // StatusContext: state = SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
    // CheckRun: status = COMPLETED | IN_PROGRESS | QUEUED | PENDING, conclusion =
    //           SUCCESS | FAILURE | CANCELLED | TIMED_OUT | NEUTRAL | SKIPPED | ""
    const state = typeof n.state === 'string' ? n.state : undefined;
    const status = typeof n.status === 'string' ? n.status : undefined;
    const conclusion = typeof n.conclusion === 'string' ? n.conclusion : undefined;
    if (state === 'FAILURE' || state === 'ERROR' || conclusion === 'FAILURE' || conclusion === 'CANCELLED' || conclusion === 'TIMED_OUT') {
      return 'fail';
    }
    if (state === 'PENDING' || state === 'EXPECTED' || (status && status !== 'COMPLETED')) {
      sawPending = true;
      continue;
    }
    // Only a real SUCCESS earns 'pass' — a rollup of nothing but SKIPPED /
    // NEUTRAL checks proves nothing ran, so it stays null (dash), not a
    // misleading green (review r2).
    if (state === 'SUCCESS' || conclusion === 'SUCCESS') {
      sawPass = true;
    }
  }
  if (sawPending) return 'pending';
  return sawPass ? 'pass' : null;
}

// --- table composition ---

// Compact display labels for the normalized states. Label mapping only — the
// underlying state string is never altered or invented.
const STATE_LABELS: Record<string, string> = {
  todo: 'todo',
  'in-progress': 'doing',
  'in-review': 'review',
  done: 'done',
  cancelled: 'cancelled',
};

const CI_LABELS: Record<Exclude<CiState, null>, string> = {
  pass: '✓ pass',
  fail: '✗ fail',
  pending: '… running',
};

// Keep the reply phone-readable and inside the rich limits (≤32768 chars,
// ≤500 blocks): cap the row count and say how many were cut.
export const MAX_TABLE_ROWS = 40;
const TITLE_MAX = 60;
const DASH = '—';

export interface ComposeOpts {
  status: string | null; // normalized status or 'all'; null = OPEN_STATES
  // Projects whose PR lookup failed (gh error) — their PR/CI cells are dashed
  // and a footnote names them.
  prLookupFailed?: string[];
  // Projects deliberately NOT PR-checked (over the entrypoint's project cap) —
  // footnoted separately so their dashes read "not checked", never "no PR"
  // (review r2: a silent dash for an unchecked project fabricates "no PR").
  prNotChecked?: string[];
}

export interface ComposedTable {
  html: string;
  empty: boolean; // no ticket matched the filter
  rows: number; // rows rendered (before the "… N more" trailer)
  // Data-quality notes (broken projects, failed/skipped PR lookups) as plain
  // text. Also populated when the board is EMPTY, so the entrypoint's
  // "no tasks" reply still surfaces a backend error instead of hiding it
  // behind a cheerful empty board (review r2).
  notes: string[];
}

function stateMatches(state: string, filter: string | null): boolean {
  if (filter === 'all') return true;
  if (filter === null) return OPEN_STATES.has(state);
  return state === filter;
}

function truncateTitle(title: string): string {
  const chars = [...title];
  return chars.length <= TITLE_MAX ? title : `${chars.slice(0, TITLE_MAX - 1).join('')}…`;
}

function ticketCell(t: TaskTicket): string {
  const label = escapeHtml(t.id);
  return t.url ? `<a href="${escapeHtml(t.url)}">${label}</a>` : label;
}

function prCell(pr: PrInfo | undefined): string {
  if (!pr) return DASH;
  const label = escapeHtml(`#${pr.number}`);
  const link = pr.url ? `<a href="${escapeHtml(pr.url)}">${label}</a>` : label;
  const marks: string[] = [];
  if (pr.isDraft) marks.push('draft');
  else if (pr.state === 'MERGED') marks.push('merged');
  else if (pr.state === 'CLOSED') marks.push('closed');
  if (pr.reviewDecision === 'APPROVED') marks.push('approved');
  else if (pr.reviewDecision === 'CHANGES_REQUESTED') marks.push('changes');
  return marks.length ? `${link} (${marks.join(', ')})` : link;
}

function ciCell(pr: PrInfo | undefined, lookupFailed: boolean): string {
  if (lookupFailed || !pr) return DASH;
  const ci = ciStateOf(pr.statusCheckRollup);
  return ci ? CI_LABELS[ci] : DASH;
}

interface Row {
  project: string;
  cells: string[]; // pre-escaped/linked cell HTML, in column order
}

// Compose the /tasks reply table. `prsByProject` maps a project key to the PRs
// fetched for it; a project absent from the map with `prLookupFailed` listing it
// renders dashed PR/CI cells + a footnote.
export function composeTasksTable(
  projects: TaskProject[],
  prsByProject: Map<string, PrInfo[]>,
  opts: ComposeOpts,
): ComposedTable {
  const failed = new Set(opts.prLookupFailed ?? []);
  const notChecked = new Set(opts.prNotChecked ?? []);
  const rows: Row[] = [];
  const brokenProjects: string[] = [];
  for (const p of projects) {
    if (p.error) {
      brokenProjects.push(p.project);
      continue;
    }
    const tickets = p.tickets.filter((t) => stateMatches(t.state, opts.status));
    if (tickets.length === 0) continue;
    const links = linkPrsToTickets(tickets, prsByProject.get(p.project) ?? [], p.project);
    for (const t of tickets) {
      const n = ticketNumberOf(t.id);
      const pr = n === null ? undefined : links.get(n);
      const prUnknown = failed.has(p.project) || notChecked.has(p.project);
      rows.push({
        project: p.project,
        cells: [
          ticketCell(t),
          escapeHtml(truncateTitle(t.title)),
          escapeHtml(STATE_LABELS[t.state] ?? t.state),
          prCell(pr),
          ciCell(pr, prUnknown),
          t.due ? escapeHtml(t.due) : DASH,
        ],
      });
    }
  }

  const notes: string[] = [];
  if (brokenProjects.length > 0) notes.push(`task list failed for: ${brokenProjects.join(', ')}`);
  if (failed.size > 0) notes.push(`PR/CI lookup failed for: ${[...failed].join(', ')}`);
  if (notChecked.size > 0) notes.push(`PR/CI not checked (project cap) for: ${[...notChecked].join(', ')}`);

  if (rows.length === 0) return { html: '', empty: true, rows: 0, notes };

  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const cut = rows.length - shown.length;
  const multiProject = new Set(shown.map((r) => r.project)).size > 1;

  const parts: string[] = ['<table>'];
  parts.push('<tr><th>Ticket</th><th>Title</th><th>State</th><th>PR</th><th>CI</th><th>Due</th></tr>');
  let lastProject: string | null = null;
  for (const r of shown) {
    if (multiProject && r.project !== lastProject) {
      parts.push(`<tr><td colspan="6"><b>${escapeHtml(r.project)}</b></td></tr>`);
      lastProject = r.project;
    }
    parts.push(`<tr>${r.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
  }
  if (cut > 0) {
    parts.push(`<tr><td colspan="6">… ${cut} more — narrow with /tasks &lt;agent&gt; or /tasks &lt;status&gt;</td></tr>`);
  }
  parts.push('</table>');
  for (const note of notes) {
    parts.push(`<i>${escapeHtml(note)}</i>`);
  }
  return { html: parts.join('\n'), empty: false, rows: shown.length, notes };
}

// Which projects deserve a gh PR lookup, honoring the STATUS filter and the
// cap: a project none of whose tickets will render must not spend a gh spawn,
// and the cap must be spent on projects that actually contribute rows — not on
// the array's first N (review r3). `notChecked` are the over-cap leftovers,
// footnoted so their dashes read "not checked".
export function selectPrLookupProjects(
  projects: TaskProject[],
  status: string | null,
  cap: number,
): { check: TaskProject[]; notChecked: string[] } {
  const relevant = projects.filter(
    (p) =>
      !p.error &&
      p.backend === 'github-issues' &&
      /^[\w.-]+\/[\w.-]+$/.test(p.project) &&
      p.tickets.some((t) => stateMatches(t.state, status)),
  );
  return {
    check: relevant.slice(0, cap),
    notChecked: relevant.slice(cap).map((p) => p.project),
  };
}

// The plain-text reply when nothing matches — names the filter so the operator
// knows what was searched, not just "nothing".
export function emptyTasksReply(status: string | null): string {
  if (status === null) return 'no open tasks (todo/in-progress/in-review) — try /tasks all';
  return `no tasks with status '${status}'`;
}

import { describe, expect, test } from 'bun:test';
import {
  asPrInfo,
  ciStateOf,
  composeTasksTable,
  emptyTasksReply,
  linkPrsToTickets,
  MAX_TABLE_ROWS,
  normalizeStatus,
  normalizeTaskListJson,
  parseTasksCommand,
  prReferencesTicket,
  selectPrLookupProjects,
  ticketNumberOf,
  type PrInfo,
  type TaskProject,
  type TaskTicket,
} from '../features/tg-ctl/tasks-report';
import { validateRichHtml } from '../features/render/rich';

function ticket(over: Partial<TaskTicket> = {}): TaskTicket {
  return { id: '#7', title: 'Fix the thing', state: 'todo', url: 'https://github.com/o/r/issues/7', labels: [], what: '', due: '', ...over };
}

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 12,
    title: 'fix: the thing',
    body: 'Closes #7',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    statusCheckRollup: [],
    url: 'https://github.com/o/r/pull/12',
    ...over,
  };
}

function project(over: Partial<TaskProject> = {}): TaskProject {
  return { project: 'o/r', backend: 'github-issues', current: true, error: null, tickets: [ticket()], ...over };
}

describe('parseTasksCommand', () => {
  test('bare /tasks → no filters', () => {
    expect(parseTasksCommand('/tasks')).toEqual({ agent: null, status: null, error: null });
  });
  test('lone status arg is a status, not an agent', () => {
    expect(parseTasksCommand('/tasks done')).toEqual({ agent: null, status: 'done', error: null });
    expect(parseTasksCommand('/tasks doing')).toEqual({ agent: null, status: 'in-progress', error: null });
    expect(parseTasksCommand('/tasks all')).toEqual({ agent: null, status: 'all', error: null });
  });
  test('lone non-status arg is an agent selector', () => {
    expect(parseTasksCommand('/tasks rig')).toEqual({ agent: 'rig', status: null, error: null });
  });
  test('agent + status', () => {
    expect(parseTasksCommand('/tasks rig done')).toEqual({ agent: 'rig', status: 'done', error: null });
  });
  test('agent + junk status is an explicit error, never silently ignored', () => {
    const p = parseTasksCommand('/tasks rig junk');
    expect(p.error).toContain("unknown status 'junk'");
  });
  test('three args is a usage error', () => {
    expect(parseTasksCommand('/tasks a b c').error).toContain('usage');
  });
  test('tolerates /tasks@botname', () => {
    expect(parseTasksCommand('/tasks@mybot done').status).toBe('done');
  });
});

describe('normalizeStatus', () => {
  test('aliases fold to task-cli states', () => {
    expect(normalizeStatus('open')).toBe('todo');
    expect(normalizeStatus('backlog')).toBe('todo');
    expect(normalizeStatus('started')).toBe('in-progress');
    expect(normalizeStatus('inreview')).toBe('in-review');
    expect(normalizeStatus('review')).toBe('in-review');
    expect(normalizeStatus('closed')).toBe('done');
    expect(normalizeStatus('canceled')).toBe('cancelled');
    expect(normalizeStatus('IN_PROGRESS')).toBe('in-progress');
  });
  test('junk → null', () => {
    expect(normalizeStatus('bananas')).toBeNull();
  });
});

describe('ticket/PR linkage', () => {
  test('ticketNumberOf parses github ids only', () => {
    expect(ticketNumberOf('#106')).toBe(106);
    expect(ticketNumberOf('HYP-42')).toBeNull();
  });
  test('word-boundary: #106 does not match #1066', () => {
    expect(prReferencesTicket(pr({ body: 'refs #1066' }), 106)).toBe(false);
    expect(prReferencesTicket(pr({ body: 'refs #106' }), 106)).toBe(true);
    expect(prReferencesTicket(pr({ body: 'refs #106.' }), 106)).toBe(true);
  });
  test('a PR does not self-reference its own number', () => {
    expect(prReferencesTicket(pr({ number: 7, body: 'about #7' }), 7)).toBe(false);
  });
  test('reference in title counts too', () => {
    expect(prReferencesTicket(pr({ body: '', title: 'fix #7 properly' }), 7)).toBe(true);
  });
  test('same-repo owner/repo#N form matches only with the project known', () => {
    expect(prReferencesTicket(pr({ body: 'Closes o/r#7' }), 7)).toBe(false); // bare guard rejects word char before #
    expect(prReferencesTicket(pr({ body: 'Closes o/r#7' }), 7, 'o/r')).toBe(true);
    expect(prReferencesTicket(pr({ body: 'Closes o/other#7' }), 7, 'o/r')).toBe(false);
  });
  test('linkPrsToTickets picks open over merged over closed, newest within state', () => {
    const tickets = [ticket({ id: '#7' })];
    const prs = [
      pr({ number: 20, state: 'CLOSED' }),
      pr({ number: 21, state: 'MERGED' }),
      pr({ number: 22, state: 'MERGED' }),
      pr({ number: 15, state: 'OPEN' }),
    ];
    const links = linkPrsToTickets(tickets, prs);
    expect(links.get(7)?.number).toBe(15);
    const noOpen = linkPrsToTickets(tickets, prs.slice(0, 3));
    expect(noOpen.get(7)?.number).toBe(22);
  });
  test('no referencing PR → no entry (never guessed)', () => {
    expect(linkPrsToTickets([ticket({ id: '#7' })], [pr({ body: 'unrelated' })]).size).toBe(0);
  });
});

describe('ciStateOf', () => {
  test('empty/absent rollup → null', () => {
    expect(ciStateOf([])).toBeNull();
    expect(ciStateOf(undefined)).toBeNull();
    expect(ciStateOf('junk')).toBeNull();
  });
  test('any failure wins', () => {
    expect(ciStateOf([{ state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('fail');
    expect(ciStateOf([{ state: 'ERROR' }])).toBe('fail');
    expect(ciStateOf([{ status: 'COMPLETED', conclusion: 'TIMED_OUT' }])).toBe('fail');
  });
  test('pending beats pass', () => {
    expect(ciStateOf([{ state: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }])).toBe('pending');
    expect(ciStateOf([{ state: 'PENDING' }])).toBe('pending');
  });
  test('all green → pass (CheckRun and StatusContext shapes)', () => {
    expect(ciStateOf([{ state: 'SUCCESS' }])).toBe('pass');
    expect(ciStateOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }])).toBe('pass');
  });
  test('skipped/neutral-only rollup proves nothing ran → null, not pass', () => {
    expect(ciStateOf([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { status: 'COMPLETED', conclusion: 'NEUTRAL' }])).toBeNull();
  });
});

describe('normalizeTaskListJson', () => {
  test('project-grouped shape passes through', () => {
    const parsed = [{ project: 'o/r', backend: 'github-issues', current: true, error: null, tickets: [ticket()] }];
    const out = normalizeTaskListJson(parsed);
    expect(out).toHaveLength(1);
    expect(out![0].project).toBe('o/r');
    expect(out![0].tickets[0].id).toBe('#7');
  });
  test('flat scoped shape derives the project from ticket urls', () => {
    const out = normalizeTaskListJson([ticket({ url: 'https://github.com/alex/repo/issues/7' })]);
    expect(out).toHaveLength(1);
    expect(out![0].project).toBe('alex/repo');
    expect(out![0].backend).toBe('github-issues');
  });
  test('junk → null (reported, never rendered as an empty board)', () => {
    expect(normalizeTaskListJson('nope')).toBeNull();
    expect(normalizeTaskListJson([{ mystery: 1 }])).toBeNull();
  });
  test('empty array is a valid empty board', () => {
    expect(normalizeTaskListJson([])).toEqual([]);
  });
  test('project block with error is preserved', () => {
    const out = normalizeTaskListJson([{ project: 'o/r', backend: 'github-issues', current: false, error: 'boom', tickets: [] }]);
    expect(out![0].error).toBe('boom');
  });
  test('grouped detection survives a FAILED project leading the array (no tickets field)', () => {
    const out = normalizeTaskListJson([
      { project: 'o/broken', backend: 'github-issues', current: false, error: 'not authed' },
      { project: 'o/ok', backend: 'github-issues', current: true, error: null, tickets: [ticket()] },
    ]);
    expect(out).toHaveLength(2);
    expect(out![0].error).toBe('not authed');
    expect(out![1].tickets[0].id).toBe('#7');
  });
});

describe('selectPrLookupProjects', () => {
  const withStates = (name: string, states: string[]) =>
    project({ project: name, tickets: states.map((s, i) => ticket({ id: `#${i + 1}`, state: s })) });
  test('a project with no tickets matching the status filter spends no gh slot', () => {
    const ps = [withStates('o/open', ['todo']), withStates('o/doneonly', ['done'])];
    const sel = selectPrLookupProjects(ps, null, 5);
    expect(sel.check.map((p) => p.project)).toEqual(['o/open']);
    const selDone = selectPrLookupProjects(ps, 'done', 5);
    expect(selDone.check.map((p) => p.project)).toEqual(['o/doneonly']);
  });
  test('cap is spent on relevant projects; leftovers are notChecked', () => {
    const ps = [withStates('o/a', ['todo']), withStates('o/b', ['todo']), withStates('o/c', ['todo'])];
    const sel = selectPrLookupProjects(ps, null, 2);
    expect(sel.check.map((p) => p.project)).toEqual(['o/a', 'o/b']);
    expect(sel.notChecked).toEqual(['o/c']);
  });
  test('errored, non-github and malformed project names are excluded', () => {
    const ps = [
      project({ error: 'boom' }),
      project({ project: 'HYP', backend: 'linear' }),
      project({ project: 'not a repo', backend: 'github-issues' }),
      withStates('o/ok', ['todo']),
    ];
    expect(selectPrLookupProjects(ps, null, 5).check.map((p) => p.project)).toEqual(['o/ok']);
  });
});

describe('asPrInfo', () => {
  test('null body (PR without description) normalizes to empty string', () => {
    const p = asPrInfo({ number: 3, title: 't', body: null, state: 'OPEN', isDraft: false, reviewDecision: null, statusCheckRollup: [], url: 'u' });
    expect(p).not.toBeNull();
    expect(p!.body).toBe('');
    expect(p!.reviewDecision).toBe('');
  });
  test('junk elements are rejected', () => {
    expect(asPrInfo(null)).toBeNull();
    expect(asPrInfo({ title: 'no number' })).toBeNull();
  });
});

describe('composeTasksTable', () => {
  test('default filter shows open states only', () => {
    const p = project({
      tickets: [ticket({ id: '#1', state: 'todo' }), ticket({ id: '#2', state: 'done' }), ticket({ id: '#3', state: 'in-review' })],
    });
    const t = composeTasksTable([p], new Map(), { status: null });
    expect(t.empty).toBe(false);
    expect(t.html).toContain('#1');
    expect(t.html).toContain('#3');
    expect(t.html).not.toContain('#2');
  });
  test('status filter narrows; all widens', () => {
    const p = project({ tickets: [ticket({ id: '#1', state: 'todo' }), ticket({ id: '#2', state: 'done' })] });
    expect(composeTasksTable([p], new Map(), { status: 'done' }).html).not.toContain('#1');
    const all = composeTasksTable([p], new Map(), { status: 'all' }).html;
    expect(all).toContain('#1');
    expect(all).toContain('#2');
  });
  test('titles are escaped and truncated; missing data renders as a dash', () => {
    const p = project({ tickets: [ticket({ title: `<b>evil & long</b> ${'x'.repeat(80)}`, due: '' })] });
    const t = composeTasksTable([p], new Map(), { status: null });
    expect(t.html).toContain('&lt;b&gt;evil &amp; long&lt;/b&gt;');
    expect(t.html).not.toContain('<b>evil');
    expect(t.html).toContain('…');
    expect(t.html).toContain('<td>—</td>'); // PR/CI/Due dashes
  });
  test('PR + CI cells render from linkage', () => {
    const p = project({ tickets: [ticket({ id: '#7' })] });
    const prs = new Map([['o/r', [pr({ statusCheckRollup: [{ state: 'SUCCESS' }] })]]]);
    const html = composeTasksTable([p], prs, { status: null }).html;
    expect(html).toContain('pull/12');
    expect(html).toContain('✓ pass');
  });
  test('pr lookup failure dashes CI and adds a footnote', () => {
    const p = project({ tickets: [ticket({ id: '#7' })] });
    const t = composeTasksTable([p], new Map(), { status: null, prLookupFailed: ['o/r'] });
    expect(t.html).toContain('PR/CI lookup failed for: o/r');
  });
  test('project header row appears only with multiple projects', () => {
    const one = composeTasksTable([project()], new Map(), { status: null });
    expect(one.html).not.toContain('colspan="6"><b>');
    const two = composeTasksTable(
      [project(), project({ project: 'o/other', tickets: [ticket({ id: '#9' })] })],
      new Map(),
      { status: null },
    );
    expect(two.html).toContain('<b>o/r</b>');
    expect(two.html).toContain('<b>o/other</b>');
  });
  test('row cap with explicit trailer', () => {
    const many = Array.from({ length: MAX_TABLE_ROWS + 5 }, (_, i) => ticket({ id: `#${i + 1}` }));
    const t = composeTasksTable([project({ tickets: many })], new Map(), { status: null });
    expect(t.rows).toBe(MAX_TABLE_ROWS);
    expect(t.html).toContain('… 5 more');
  });
  test('project-level task list error is surfaced, not hidden', () => {
    const t = composeTasksTable(
      [project({ error: 'gh not authed', tickets: [] }), project({ project: 'o/ok' })],
      new Map(),
      { status: null },
    );
    expect(t.html).toContain('task list failed for: o/r');
  });
  test('an EMPTY board still carries error notes (never a cheerful lie)', () => {
    const t = composeTasksTable([project({ error: 'gh not authed', tickets: [] })], new Map(), { status: null });
    expect(t.empty).toBe(true);
    expect(t.notes).toEqual(['task list failed for: o/r']);
  });
  test('over-cap projects are footnoted as not checked, distinct from failed', () => {
    const t = composeTasksTable([project()], new Map(), { status: null, prNotChecked: ['o/r'] });
    expect(t.html).toContain('PR/CI not checked (project cap) for: o/r');
    expect(t.html).not.toContain('lookup failed');
  });
  test('empty result flags empty and emptyTasksReply names the filter', () => {
    const t = composeTasksTable([project({ tickets: [ticket({ state: 'done' })] })], new Map(), { status: null });
    expect(t.empty).toBe(true);
    expect(emptyTasksReply(null)).toContain('/tasks all');
    expect(emptyTasksReply('done')).toContain("'done'");
  });
  test('output passes the rich-message pre-flight', () => {
    const many = Array.from({ length: MAX_TABLE_ROWS + 10 }, (_, i) =>
      ticket({ id: `#${i + 1}`, title: `Ticket ${i + 1} with a reasonably long title ${'y'.repeat(40)}` }),
    );
    const t = composeTasksTable(
      [project({ tickets: many }), project({ project: 'o/other', tickets: [ticket({ id: '#999' })] })],
      new Map([['o/r', [pr()]]]),
      { status: 'all', prLookupFailed: ['o/other'] },
    );
    const check = validateRichHtml(t.html);
    expect(check.ok).toBe(true);
  });
});

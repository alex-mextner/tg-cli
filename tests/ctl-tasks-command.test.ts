import { expect, test } from 'bun:test';
import {
  composeTasksTable,
  matchPrsToTasks,
  normalizeTaskStatus,
  parseTasksCommand,
  rollupCiState,
  tasksScopeLabel,
  type PrRef,
  type TaskItem,
} from '../features/tg-ctl/tasks-command';

test('normalizeTaskStatus: canonical + aliases + non-status', () => {
  expect(normalizeTaskStatus('todo')).toBe('todo');
  expect(normalizeTaskStatus('WIP')).toBe('in-progress');
  expect(normalizeTaskStatus('review')).toBe('in-review');
  expect(normalizeTaskStatus('closed')).toBe('done');
  expect(normalizeTaskStatus('canceled')).toBe('cancelled');
  expect(normalizeTaskStatus('hyperide')).toBeNull();
});

test('parseTasksCommand: bare, status-only, agent-only, both, order-tolerant', () => {
  expect(parseTasksCommand('/tasks')).toEqual({ agent: null, status: null });
  expect(parseTasksCommand('/tasks done')).toEqual({ agent: null, status: 'done' });
  expect(parseTasksCommand('/tasks hyperide')).toEqual({ agent: 'hyperide', status: null });
  expect(parseTasksCommand('/tasks hyperide in-review')).toEqual({ agent: 'hyperide', status: 'in-review' });
  // status first, agent second — still classified correctly
  expect(parseTasksCommand('/tasks wip hyperide')).toEqual({ agent: 'hyperide', status: 'in-progress' });
  // tolerate /tasks@botname
  expect(parseTasksCommand('/tasks@mybot done')).toEqual({ agent: null, status: 'done' });
});

test('rollupCiState: fail dominates, else pending, else pass, empty → null', () => {
  expect(rollupCiState([])).toBeNull();
  expect(rollupCiState(null)).toBeNull();
  expect(
    rollupCiState([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ]),
  ).toBe('fail');
  expect(
    rollupCiState([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS' },
    ]),
  ).toBe('pending');
  expect(rollupCiState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pass');
  // gh sometimes reports a check via `state` instead of conclusion
  expect(rollupCiState([{ state: 'SUCCESS' }])).toBe('pass');
});

const tasks: TaskItem[] = [
  { id: '#117', title: 'A task', state: 'todo', url: 'https://x/117', due: '' },
  { id: '#5', title: 'Another', state: 'in-progress', url: 'https://x/5', due: '2026-07-10' },
];

test('matchPrsToTasks: whole-token match on title or body; highest PR number wins', () => {
  const prs: PrRef[] = [
    { number: 200, url: 'https://x/pr/200', title: 'fix #117 whatever', ci: 'pass' },
    { number: 201, url: 'https://x/pr/201', title: 'unrelated', body: 'Closes #117', ci: 'fail' },
    { number: 5, url: 'https://x/pr/5', title: 'do not match #1170', ci: 'pass' }, // #1170 must NOT match #117
  ];
  const m = matchPrsToTasks(tasks, prs);
  expect(m.get('#117')!.number).toBe(201); // most recent of the two #117 matches
  expect(m.has('#5')).toBe(false); // no PR references #5
});

test('composeTasksTable: header + one row per task; missing data is an em dash, never fabricated', () => {
  const prs = matchPrsToTasks(tasks, [{ number: 42, url: 'https://x/pr/42', title: 'ref #117', ci: null }]);
  const html = composeTasksTable(tasks, prs, { agent: null, status: null });
  expect(html).toContain('<table>');
  expect(html).toContain('<a href="https://x/117">#117</a>');
  expect(html).toContain('<a href="https://x/pr/42">#42</a>');
  // #117 has no due and a PR whose CI is unknown → em dashes, not "pass"
  expect(html).not.toContain('✓'); // ci null must not render a pass glyph
  expect(html.match(/—/g)!.length).toBeGreaterThanOrEqual(2);
  // #5 has a due date and no PR
  expect(html).toContain('2026-07-10');
});

test('composeTasksTable: empty result is explicit, not an empty table', () => {
  const html = composeTasksTable([], new Map(), { agent: 'ghost', status: 'done' });
  expect(html).toContain('No matching tasks');
  expect(html).not.toContain('<table>');
});

test('composeTasksTable: HTML in a title is escaped', () => {
  const evil: TaskItem[] = [{ id: '#9', title: '<script>alert(1)</script>', state: 'todo', url: 'https://x/9' }];
  const html = composeTasksTable(evil, new Map(), { agent: null, status: null });
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
});

// CodeQL js/incomplete-html-attribute-sanitization (PR #120): a task/PR url
// carrying a `"` used to break out of the `href="..."` attribute the row
// builds. Proves the fixed escapeHtml neutralizes it in BOTH attribute
// positions (task url + PR url).
test('composeTasksTable: a `"` (or `\'`) in a url cannot break out of the href attribute', () => {
  const evil: TaskItem[] = [{ id: '#9', title: 'safe', state: 'todo', url: `https://x/9" onmouseover="alert(1)` }];
  const prs = matchPrsToTasks(evil, [
    { number: 1, url: `https://x/pr/1" onmouseover="alert(2)`, title: 'ref #9', ci: null },
  ]);
  const html = composeTasksTable(evil, prs, { agent: null, status: null });
  expect(html).not.toContain('" onmouseover="');
  expect(html).toContain('href="https://x/9&quot; onmouseover=&quot;alert(1)"');
  expect(html).toContain('href="https://x/pr/1&quot; onmouseover=&quot;alert(2)"');
});

test('tasksScopeLabel', () => {
  expect(tasksScopeLabel({ agent: null, status: null })).toBe('Tasks');
  expect(tasksScopeLabel({ agent: 'hyperide', status: 'done' })).toContain('agent <b>hyperide</b>');
  expect(tasksScopeLabel({ agent: null, status: 'done' })).toContain('status <b>done</b>');
});

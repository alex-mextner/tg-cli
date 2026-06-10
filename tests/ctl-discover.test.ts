import { expect, test } from 'bun:test';
import {
  parsePaneList,
  parseProcList,
  findAgentInPane,
  findAgentInAncestry,
  pickTargetPane,
} from '../features/tg-ctl/discover';
import type { PaneInfo, ProcInfo } from '../features/tg-ctl/types';

// --- fixtures ---

function pane(
  sessionName: string,
  windowIndex: number,
  paneId: string,
  panePid: number,
  paneCommand: string,
  panePath: string,
): PaneInfo {
  return { sessionName, windowIndex, paneId, panePid, paneCommand, panePath };
}

function proc(pid: number, ppid: number, command: string): ProcInfo {
  return { pid, ppid, command };
}

// --- parsePaneList ---

test('parsePaneList parses tab-separated pane lines', () => {
  const out = 'main\t0\t%0\t100\t-zsh\t/Users/ultra/work\nside\t2\t%5\t200\topencode\t/tmp/x\n';
  expect(parsePaneList(out)).toEqual([
    pane('main', 0, '%0', 100, '-zsh', '/Users/ultra/work'),
    pane('side', 2, '%5', 200, 'opencode', '/tmp/x'),
  ]);
});

test('parsePaneList keeps paths with spaces intact (tabs protect them)', () => {
  const out = 'main\t1\t%3\t4242\t2.1.150\t/Users/ultra/my project/sub dir\n';
  const panes = parsePaneList(out);
  expect(panes).toHaveLength(1);
  expect(panes[0].panePath).toBe('/Users/ultra/my project/sub dir');
  expect(panes[0].paneCommand).toBe('2.1.150'); // cc reports its VERSION here
});

test('parsePaneList skips malformed lines', () => {
  const out = [
    '', // blank
    'too\tfew\tfields',
    'main\tNaN\t%1\t100\t-zsh\t/home', // non-numeric window index
    'main\t0\t%1\tnope\t-zsh\t/home', // non-numeric pane pid
    'good\t0\t%9\t900\tbash\t/srv',
  ].join('\n');
  expect(parsePaneList(out)).toEqual([pane('good', 0, '%9', 900, 'bash', '/srv')]);
});

// --- parseProcList ---

test('parseProcList parses ps -axo pid=,ppid=,command= output', () => {
  const out = [
    '    1     0 /sbin/launchd',
    '  100     1 -zsh',
    '  150   100 node /Users/ultra/.claude/local/claude --resume',
  ].join('\n');
  expect(parseProcList(out)).toEqual([
    proc(1, 0, '/sbin/launchd'),
    proc(100, 1, '-zsh'),
    proc(150, 100, 'node /Users/ultra/.claude/local/claude --resume'),
  ]);
});

test('parseProcList skips malformed and blank lines', () => {
  const out = ['', '   ', 'abc def ghi', '  42', '  7  3  sleep 100'].join('\n');
  expect(parseProcList(out)).toEqual([proc(7, 3, 'sleep 100')]);
});

// --- findAgentInPane ---

test('finds claude as a child of the pane shell (pane command is a VERSION string)', () => {
  // Real-world cc pane: pane_current_command is '2.1.150', not 'claude'.
  const p = pane('main', 0, '%0', 100, '2.1.150', '/Users/ultra/work');
  const procs = [proc(100, 1, '-zsh'), proc(150, 100, 'claude')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'claude', pid: 150 });
});

test('finds opencode running directly as the pane process', () => {
  const p = pane('main', 0, '%1', 200, 'opencode', '/tmp');
  const procs = [proc(200, 1, '/opt/homebrew/bin/opencode')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'opencode', pid: 200 });
});

test('finds claude nested two levels deep (claude under zsh under pane shell)', () => {
  const p = pane('main', 0, '%2', 300, '-zsh', '/home');
  const procs = [
    proc(300, 1, '-zsh'),
    proc(310, 300, 'zsh'),
    proc(320, 310, 'claude --continue'),
  ];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'claude', pid: 320 });
});

test('matches claude when the command is a node wrapper containing /claude ', () => {
  const p = pane('main', 0, '%3', 400, 'node', '/home');
  const procs = [proc(400, 1, 'node /Users/ultra/.claude/local/claude --resume')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'claude', pid: 400 });
});

test('matches codex and aider by argv0 basename', () => {
  const codexPane = pane('a', 0, '%4', 500, 'codex', '/x');
  const aiderPane = pane('a', 1, '%5', 600, 'aider', '/y');
  const procs = [
    proc(500, 1, '/opt/homebrew/bin/codex exec --json'),
    proc(600, 1, 'aider --model gpt-4o'),
  ];
  expect(findAgentInPane(codexPane, procs)).toEqual({ agent: 'codex', pid: 500 });
  expect(findAgentInPane(aiderPane, procs)).toEqual({ agent: 'aider', pid: 600 });
});

test('matches opencode.exe basename', () => {
  const p = pane('a', 0, '%6', 700, 'opencode', '/x');
  const procs = [proc(700, 1, 'C:/tools/opencode.exe serve')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'opencode', pid: 700 });
});

test('matches pi by argv0 basename', () => {
  const p = pane('a', 0, '%7', 710, 'pi', '/x');
  const procs = [proc(710, 1, '/opt/homebrew/bin/pi')];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'pi', pid: 710 });
});

test('shells and unrelated processes are traversed but never matched', () => {
  const p = pane('main', 0, '%7', 800, '-zsh', '/home');
  const procs = [
    proc(800, 1, '-zsh'),
    proc(810, 800, 'bash'),
    proc(820, 810, 'vim notes.md'),
    proc(830, 810, 'node server.js'), // not a claude wrapper
  ];
  expect(findAgentInPane(p, procs)).toBeNull();
});

test('returns the first match in BFS order (shallower process wins)', () => {
  const p = pane('main', 0, '%8', 900, '-zsh', '/home');
  const procs = [
    proc(900, 1, '-zsh'),
    proc(910, 900, 'opencode'), // depth 1
    proc(920, 910, 'claude'), // depth 2 — never reached
  ];
  expect(findAgentInPane(p, procs)).toEqual({ agent: 'opencode', pid: 910 });
});

test('survives a ppid cycle in the snapshot without hanging', () => {
  // ps snapshots can show pid-reuse artifacts; the BFS must not loop forever.
  const p = pane('main', 0, '%9', 50, '-zsh', '/home');
  const procs = [proc(50, 60, '-zsh'), proc(60, 50, 'bash')];
  expect(findAgentInPane(p, procs)).toBeNull();
});

// --- findAgentInAncestry ---
// Mirror of findAgentInPane but walking UP the ppid chain from a start pid.
// Used by outbound `tg` to learn which agent launched it as a subprocess
// (codex/aider/pi export no env marker, unlike Claude Code's CLAUDECODE).

test('finds codex as the direct parent of tg (codex launched the shell command)', () => {
  // Real shape verified live: `codex exec` is the immediate parent of the shell
  // command it runs, so process.ppid points straight at a `codex` argv0.
  const procs = [
    proc(900, 800, '/opt/homebrew/bin/codex exec --json'),
    proc(950, 900, 'tg some report'),
  ];
  expect(findAgentInAncestry(procs, 900)).toEqual({ agent: 'codex', pid: 900 });
});

test('finds codex through an intermediate shell (codex → bash -lc → tg)', () => {
  const procs = [
    proc(700, 1, 'codex --dangerously-bypass-approvals-and-sandbox'),
    proc(710, 700, 'bash -lc tg ...'),
    proc(720, 710, 'bun run tg'),
  ];
  // tg's process.ppid is 710 (the shell); walk up past it to codex.
  expect(findAgentInAncestry(procs, 710)).toEqual({ agent: 'codex', pid: 700 });
});

test('a background ollama daemon is NOT in the ancestry, so it never matches', () => {
  // The whole point of the fix: ollama runs as a sibling daemon, not an
  // ancestor of tg, so ancestry returns null and the caller must NOT pick it.
  const procs = [
    proc(11196, 1, '/opt/homebrew/bin/ollama serve'), // background daemon
    proc(800, 1, '-zsh'),
    proc(850, 800, 'bun run tg report'),
  ];
  expect(findAgentInAncestry(procs, 800)).toBeNull();
});

test('returns the shallowest agent ancestor (nearest parent wins)', () => {
  const procs = [
    proc(100, 1, 'codex exec'),
    proc(110, 100, 'aider --model x'), // nearer to tg than codex
    proc(120, 110, 'tg ...'),
  ];
  expect(findAgentInAncestry(procs, 110)).toEqual({ agent: 'aider', pid: 110 });
});

test('survives a ppid cycle in the ancestry snapshot without hanging', () => {
  const procs = [proc(50, 60, '-zsh'), proc(60, 50, 'bash')];
  expect(findAgentInAncestry(procs, 50)).toBeNull();
});

test('stops cleanly at pid 1 / missing parent', () => {
  const procs = [proc(300, 1, '-zsh')];
  expect(findAgentInAncestry(procs, 300)).toBeNull();
  expect(findAgentInAncestry(procs, 999999)).toBeNull(); // unknown start pid
});

// --- pickTargetPane ---

// Two agent panes (claude in %0, opencode in %1) plus a plain shell pane.
const PANES = [
  pane('work', 0, '%0', 100, '2.1.150', '/Users/ultra/repo-a'),
  pane('side', 0, '%1', 200, 'opencode', '/Users/ultra/repo-b'),
  pane('work', 1, '%2', 300, '-zsh', '/Users/ultra'),
];
const PROCS = [
  proc(100, 1, '-zsh'),
  proc(150, 100, 'claude'),
  proc(200, 1, 'opencode'),
  proc(300, 1, '-zsh'),
];

test('tier 1: registration paneId wins when that pane still hosts an agent', () => {
  const r = pickTargetPane(PANES, PROCS, { paneId: '%1' });
  expect(r).toEqual({
    ok: true,
    target: { pane: PANES[1], agent: 'opencode', agentPid: 200 },
  });
});

test('tier 1 falls through when the registered pane no longer hosts an agent', () => {
  // %2 is a bare shell; with two other agent panes the result is ambiguous.
  const r = pickTargetPane(PANES, PROCS, { paneId: '%2' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe('ambiguous');
});

test('tier 2: fixedSession picks the sole agent pane in that session', () => {
  const r = pickTargetPane(PANES, PROCS, null, 'work');
  expect(r).toEqual({
    ok: true,
    target: { pane: PANES[0], agent: 'claude', agentPid: 150 },
  });
});

test('tier 2: two agent panes in fixedSession → ambiguous with those candidates', () => {
  const panes = [
    pane('work', 0, '%0', 100, '2.1.150', '/a'),
    pane('work', 1, '%1', 200, 'opencode', '/b'),
    pane('other', 0, '%2', 400, 'aider', '/c'),
  ];
  const procs = [...PROCS, proc(400, 1, 'aider')];
  const r = pickTargetPane(panes, procs, null, 'work');
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe('ambiguous');
    expect(r.candidates.map((c) => c.pane.paneId)).toEqual(['%0', '%1']);
  }
});

test('tier 2 falls through when fixedSession has no agent panes', () => {
  const panes = [
    pane('empty', 0, '%5', 300, '-zsh', '/home'),
    pane('side', 0, '%1', 200, 'opencode', '/Users/ultra/repo-b'),
  ];
  const r = pickTargetPane(panes, PROCS, null, 'empty');
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.target.agent).toBe('opencode');
});

test('tier 3: registration cwd matches pane_current_path', () => {
  const r = pickTargetPane(PANES, PROCS, { cwd: '/Users/ultra/repo-b' });
  expect(r).toEqual({
    ok: true,
    target: { pane: PANES[1], agent: 'opencode', agentPid: 200 },
  });
});

test('tier 4: sole agent pane on the server wins with no registration at all', () => {
  const panes = [
    pane('work', 0, '%0', 100, '2.1.150', '/Users/ultra/repo-a'),
    pane('work', 1, '%2', 300, '-zsh', '/Users/ultra'),
  ];
  const r = pickTargetPane(panes, PROCS, null);
  expect(r).toEqual({
    ok: true,
    target: { pane: panes[0], agent: 'claude', agentPid: 150 },
  });
});

test('multiple agent panes and nothing to narrow → ambiguous with all candidates', () => {
  const r = pickTargetPane(PANES, PROCS, null);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toBe('ambiguous');
    expect(r.candidates.map((c) => c.pane.paneId)).toEqual(['%0', '%1']);
  }
});

test('no agent anywhere → no-agent with empty candidates', () => {
  const panes = [pane('work', 0, '%2', 300, '-zsh', '/Users/ultra')];
  const r = pickTargetPane(panes, PROCS, { paneId: '%2', cwd: '/Users/ultra' }, 'work');
  expect(r).toEqual({ ok: false, reason: 'no-agent', candidates: [] });
});

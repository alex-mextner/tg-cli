// Agent-scoped `tg replies` (Alex tg#8346 / #191): the history now carries a
// targetAgent per record; the reader defaults to the CURRENT agent, filters via
// --agent/--all/--untagged, and MARKS every line with its target agent.
import { expect, test } from 'bun:test';
import { parseRepliesArgs } from '../features/replies/args';
import { appendRecordsToBlob, type HistoryRecord } from '../features/replies/history';
import { runReplies, type RepliesCliDeps } from '../features/replies/cli';
import { inboundHistoryRecords } from '../features/replies/inbound';
import { buildOutboundHistoryRecords } from '../features/replies/outbound';
import type { TgUpdate } from '../features/tg-ctl/types';

const R = (over: Partial<HistoryRecord>): HistoryRecord => ({
  ts: 1700000000,
  message_id: 1,
  direction: 'user',
  from: 'Alex',
  text: 'hi',
  pane: '%1',
  ...over,
});

// A history with three agents' inbound + one legacy untagged row.
const MIXED: HistoryRecord[] = [
  R({ message_id: 10, text: 'to rig', pane: '%1', targetAgent: 'rig' }),
  R({ message_id: 11, text: 'to ext', pane: '%2', targetAgent: 'ext' }),
  R({ message_id: 12, text: 'to rig again', pane: '%1', targetAgent: 'rig' }),
  R({ message_id: 13, text: 'legacy row' }), // no targetAgent
];

function run(argv: string[], currentAgent: string | null, records: HistoryRecord[]) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: RepliesCliDeps = {
    readHistory: () => appendRecordsToBlob(null, records),
    detectPane: () => null,
    currentAgent: () => currentAgent,
    resolveWindow: () => [],
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: (m) => err.push(m),
  };
  const code = runReplies(argv, deps);
  return { code, out, err };
}

// --- args ---

test('parseRepliesArgs: --agent/--all/--untagged set the agent scope', () => {
  expect((parseRepliesArgs([]) as { agentScope: unknown }).agentScope).toEqual({ mode: 'current' });
  expect((parseRepliesArgs(['--all']) as { agentScope: unknown }).agentScope).toEqual({ mode: 'all' });
  expect((parseRepliesArgs(['--untagged']) as { agentScope: unknown }).agentScope).toEqual({ mode: 'untagged' });
  expect((parseRepliesArgs(['--agent', 'rig']) as { agentScope: unknown }).agentScope).toEqual({
    mode: 'named',
    name: 'rig',
  });
});

test('parseRepliesArgs: --agent requires a name; scopes are mutually exclusive', () => {
  expect(parseRepliesArgs(['--agent'])).toEqual({ kind: 'error', message: '--agent requires an agent name' });
  const conflict = parseRepliesArgs(['--all', '--untagged']);
  expect(conflict.kind).toBe('error');
});

// --- default = current agent ---

test('default scope shows ONLY the current agent, marked [→ agent]', () => {
  const { code, out, err } = run(['replies'], 'rig', MIXED);
  expect(code).toBe(0);
  expect(out).toEqual(['[T] #10 [→ rig] to rig', '[T] #12 [→ rig] to rig again']);
  expect(err).toEqual([]); // current agent resolved → no note
});

test('current-agent match is case-insensitive', () => {
  const { out } = run(['replies'], 'RIG', MIXED);
  expect(out.map((l) => l.replace(/^\[T\] /, ''))).toEqual(['#10 [→ rig] to rig', '#12 [→ rig] to rig again']);
});

test('when the current agent cannot be resolved, default degrades to untagged + a stderr note', () => {
  const { out, err } = run(['replies'], null, MIXED);
  expect(out).toEqual(['[T] #13 [→ ?] legacy row']);
  expect(err.join(' ')).toContain('could not determine the current agent');
});

// --- --agent <name> ---

test('--agent ext filters to that agent regardless of the current pane', () => {
  const { out } = run(['replies', '--agent', 'ext'], 'rig', MIXED);
  expect(out).toEqual(['[T] #11 [→ ext] to ext']);
});

// --- --all ---

test('--all shows every agent AND untagged, each line marked', () => {
  const { out, err } = run(['replies', '--all'], 'rig', MIXED);
  expect(out).toEqual([
    '[T] #10 [→ rig] to rig',
    '[T] #11 [→ ext] to ext',
    '[T] #12 [→ rig] to rig again',
    '[T] #13 [→ ?] legacy row',
  ]);
  expect(err).toEqual([]); // explicit scope → no current-agent note
});

// --- --untagged ---

test('--untagged shows only legacy / no-target rows', () => {
  const { out } = run(['replies', '--untagged'], 'rig', MIXED);
  expect(out).toEqual(['[T] #13 [→ ?] legacy row']);
});

// --- empty note carries the agent scope ---

test('empty result names the agent scope searched', () => {
  const { out } = run(['replies', '--agent', 'ghost'], 'rig', MIXED);
  expect(out[0]).toContain("for agent 'ghost'");
});

// --- WRITE path stamps targetAgent ---

test('inbound writer stamps targetAgent from resolveAgent(pane)', () => {
  const updates: TgUpdate[] = [
    {
      update_id: 1,
      message: { message_id: 20, chat: { id: 7 }, date: 1700000000, from: { id: 7, first_name: 'Alex' }, text: 'yo' },
    },
  ];
  const [rec] = inboundHistoryRecords(updates, {
    chatId: 7,
    allowedSenders: [],
    pane: '%9',
    resolveAgent: (pane) => (pane === '%9' ? 'rig' : null),
  });
  expect(rec.targetAgent).toBe('rig');
});

test('inbound writer leaves targetAgent absent when resolveAgent yields null', () => {
  const updates: TgUpdate[] = [
    {
      update_id: 1,
      message: { message_id: 21, chat: { id: 7 }, date: 1700000000, from: { id: 7, first_name: 'Alex' }, text: 'yo' },
    },
  ];
  const [rec] = inboundHistoryRecords(updates, { chatId: 7, allowedSenders: [], pane: null });
  expect('targetAgent' in rec).toBe(false);
});

test('outbound writer stamps targetAgent on every sibling of a multi-part send', () => {
  const recs = buildOutboundHistoryRecords([30, 31], 'chunked', 1700000000, '%1', 'tok', 7, 'rig');
  expect(recs.map((r) => r.targetAgent)).toEqual(['rig', 'rig']);
});

test('outbound writer leaves targetAgent absent when no agent name is given', () => {
  const [rec] = buildOutboundHistoryRecords([30], 'x', 1700000000, '%1', 'tok', 7);
  expect('targetAgent' in rec).toBe(false);
});

// --- round trip through a real serialized blob ---

test('targetAgent survives serialize → parse (blob round trip)', () => {
  const { out } = run(['replies', '--agent', 'rig'], 'rig', [R({ message_id: 40, targetAgent: 'rig' })]);
  expect(out).toEqual(['[T] #40 [→ rig] hi']);
});

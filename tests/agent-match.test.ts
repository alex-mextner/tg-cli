import { expect, test } from 'bun:test';
import {
  parseAgentCommand,
  phoneticKey,
  matchWindows,
  groupBySession,
  buildAgentSelectMessage,
  parseAgentCallback,
  type AgentCandidate,
} from '../features/tg-ctl/agent-match';

const cand = (
  paneId: string,
  sessionName: string,
  windowIndex: number,
  windowName: string,
  agent: AgentCandidate['agent'] = 'claude',
): AgentCandidate => ({ paneId, sessionName, windowIndex, windowName, agent });

// --- parseAgentCommand ---

test('parse: selector + message', () => {
  expect(parseAgentCommand('/agent feat-bot deploy now')).toEqual({
    selector: 'feat-bot',
    rest: 'deploy now',
    all: 'feat-bot deploy now',
  });
});

test('parse: bare /agent → no selector', () => {
  expect(parseAgentCommand('/agent')).toEqual({ selector: null, rest: '', all: '' });
  expect(parseAgentCommand('/agent   ')).toEqual({ selector: null, rest: '', all: '' });
});

test('parse: single token → selector with empty rest', () => {
  expect(parseAgentCommand('/agent apibot')).toEqual({ selector: 'apibot', rest: '', all: 'apibot' });
});

test('parse: tolerates /agent@botname and multiline', () => {
  expect(parseAgentCommand('/agent@mybot api\nline two')).toEqual({
    selector: 'api',
    rest: 'line two',
    all: 'api\nline two',
  });
});

// --- phoneticKey ---

test('phonetic: Cyrillic transliterates to the same key as Latin', () => {
  expect(phoneticKey('апи')).toBe('api');
  expect(phoneticKey('Codex')).toBe(phoneticKey('кодекс')); // both → kodeks
});

test('phonetic: folds separators, doubles, and sound-equivalents', () => {
  expect(phoneticKey('api-bot')).toBe('apibot');
  expect(phoneticKey('ph')).toBe('f');
  expect(phoneticKey('mood')).toBe('mod'); // doubled o collapses
  expect(phoneticKey('claude')).toBe('klaude'); // hard c → k
});

// --- matchWindows ---

const fleet = [
  cand('%1', 'work', 0, 'api-bot', 'claude'),
  cand('%2', 'work', 1, 'feat-autolink', 'codex'),
  cand('%3', 'side', 0, 'claude-main', 'claude'),
];

test('match: exact-ish phonetic selector is confident', () => {
  const r = matchWindows('apibot', fleet);
  expect(r.confident).toBe(true);
  expect(r.matches[0].paneId).toBe('%1');
});

test('match: Cyrillic selector matches Latin window', () => {
  const r = matchWindows('апибот', fleet);
  expect(r.confident).toBe(true);
  expect(r.matches[0].windowName).toBe('api-bot');
});

test('match: ambiguous prefix returns several, not confident', () => {
  const two = [cand('%1', 's', 0, 'feat-a'), cand('%2', 's', 1, 'feat-b')];
  const r = matchWindows('feat', two);
  expect(r.confident).toBe(false);
  expect(r.matches.length).toBe(2);
});

test('match: gibberish selector matches nothing', () => {
  expect(matchWindows('zzzqqq', fleet).matches).toEqual([]);
});

// --- groupBySession ---

test('group: sessions in first-appearance order, panes by window index', () => {
  const groups = groupBySession([
    cand('%2', 'work', 1, 'b'),
    cand('%3', 'side', 0, 'c'),
    cand('%1', 'work', 0, 'a'),
  ]);
  expect(groups.map((g) => g.session)).toEqual(['work', 'side']);
  expect(groups[0].candidates.map((c) => c.paneId)).toEqual(['%1', '%2']);
});

// --- buttons round-trip ---

test('buttons: one per candidate, callback round-trips to the right pane', () => {
  const msg = buildAgentSelectMessage(42, fleet, 'tok1', 'deploy the thing');
  const flat = msg.reply_markup.inline_keyboard.flat();
  expect(flat.length).toBe(3);
  const parsed = parseAgentCallback(flat[2].callback_data);
  expect(parsed).toEqual({ token: 'tok1', index: 2 });
  expect(fleet[parsed!.index].paneId).toBe('%3');
  expect(msg.text).toContain('▸ work');
  expect(msg.text).toContain('deploy the thing');
});

test('parseAgentCallback: rejects malformed data', () => {
  expect(parseAgentCallback('tgq:tok:0')).toBeNull();
  expect(parseAgentCallback('tga:tok')).toBeNull();
  expect(parseAgentCallback('tga::1')).toBeNull();
  expect(parseAgentCallback(undefined)).toBeNull();
});

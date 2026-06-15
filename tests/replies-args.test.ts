import { expect, test } from 'bun:test';
import { parseRepliesArgs } from '../features/replies/args';

test('parseRepliesArgs: bare `replies` → direction=user, action=list, scope=session, limit 20', () => {
  const a = parseRepliesArgs([]);
  expect(a.kind).toBe('query');
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('user');
  expect(a.action).toBe('list');
  expect(a.allSessions).toBe(false);
  expect(a.session).toBeUndefined();
  expect(a.limit).toBe(20);
  expect(a.full).toBe(false);
  expect(a.json).toBe(false);
  expect(a.query).toBeUndefined();
  expect(a.regex).toBe(false);
});

test('parseRepliesArgs: explicit direction `agent`', () => {
  const a = parseRepliesArgs(['agent']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('agent');
  expect(a.action).toBe('list');
});

test('parseRepliesArgs: explicit direction `all`', () => {
  const a = parseRepliesArgs(['all']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('all');
});

test('parseRepliesArgs: `list` alone keeps default direction user', () => {
  const a = parseRepliesArgs(['list']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('user');
  expect(a.action).toBe('list');
});

test('parseRepliesArgs: `user list`', () => {
  const a = parseRepliesArgs(['user', 'list']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('user');
  expect(a.action).toBe('list');
});

test('parseRepliesArgs: `find <query>` defaults direction user and joins the rest of argv', () => {
  const a = parseRepliesArgs(['find', 'deploy', 'the', 'thing']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('user');
  expect(a.action).toBe('find');
  expect(a.query).toBe('deploy the thing');
});

test('parseRepliesArgs: `all find foo`', () => {
  const a = parseRepliesArgs(['all', 'find', 'foo']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('all');
  expect(a.action).toBe('find');
  expect(a.query).toBe('foo');
});

test('parseRepliesArgs: find with no query is an error', () => {
  const a = parseRepliesArgs(['find']);
  expect(a.kind).toBe('error');
});

test('parseRepliesArgs: -n / --limit override', () => {
  expect((parseRepliesArgs(['-n', '5']) as { limit: number }).limit).toBe(5);
  expect((parseRepliesArgs(['--limit', '99']) as { limit: number }).limit).toBe(99);
  expect((parseRepliesArgs(['user', 'list', '--limit', '3']) as { limit: number }).limit).toBe(3);
});

test('parseRepliesArgs: invalid limit is an error', () => {
  expect(parseRepliesArgs(['-n', 'abc']).kind).toBe('error');
  expect(parseRepliesArgs(['-n', '0']).kind).toBe('error');
  expect(parseRepliesArgs(['-n', '-4']).kind).toBe('error');
});

test('parseRepliesArgs: --full, --json, --regex, --all-sessions flags', () => {
  const a = parseRepliesArgs(['all', 'find', 'x', '--full', '--json', '--regex', '--all-sessions']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.full).toBe(true);
  expect(a.json).toBe(true);
  expect(a.regex).toBe(true);
  expect(a.allSessions).toBe(true);
});

test('parseRepliesArgs: --session <pane> sets explicit pane scope', () => {
  const a = parseRepliesArgs(['--session', '%7']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.session).toBe('%7');
  expect(a.allSessions).toBe(false);
});

test('parseRepliesArgs: --session requires a value', () => {
  expect(parseRepliesArgs(['--session']).kind).toBe('error');
});

test('parseRepliesArgs: --help → help action', () => {
  expect(parseRepliesArgs(['--help']).kind).toBe('help');
  expect(parseRepliesArgs(['-h']).kind).toBe('help');
});

test('parseRepliesArgs: flags may appear before positionals', () => {
  const a = parseRepliesArgs(['--json', 'agent', 'find', 'ship']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.direction).toBe('agent');
  expect(a.action).toBe('find');
  expect(a.query).toBe('ship');
  expect(a.json).toBe(true);
});

test('parseRepliesArgs: regex query keeps spaces and special chars verbatim', () => {
  const a = parseRepliesArgs(['user', 'find', 'foo.*bar', '--regex']);
  if (a.kind !== 'query') throw new Error('unreachable');
  expect(a.query).toBe('foo.*bar');
  expect(a.regex).toBe(true);
});

test('parseRepliesArgs: unknown flag is an error', () => {
  expect(parseRepliesArgs(['--nope']).kind).toBe('error');
});

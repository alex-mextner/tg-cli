import { expect, test } from 'bun:test';
import { parseArgs } from '../features/cli/args';

const HOME = '/home/tester';
const dir = '/tmp/tg-agent-flag-args-nonexistent-dir';

test('--agent <name> is parsed and composes with a body', () => {
  expect(parseArgs(['--agent', 'hyperide-fixer', 'the body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'the body',
    format: 'plain',
    agent: 'hyperide-fixer',
  });
});

// Bare --agent with no body still sends (a header-only message), same as
// --title/--tag — the "empty invocation" gate treats it as real content.
test('bare --agent with no body still sends (header-only)', () => {
  expect(parseArgs(['--agent', 'subagent'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '',
    format: 'plain',
    agent: 'subagent',
  });
});

test('--agent composes with --title and --tag', () => {
  expect(parseArgs(['--agent', 'sub-1', '--tag', 'report', '--title', 'Done', 'body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'body',
    format: 'plain',
    agent: 'sub-1',
    tag: 'report',
    title: 'Done',
  });
});

test('--agent requires a value (a dashed next token is a missing value)', () => {
  expect(parseArgs(['--agent'], dir, HOME)).toEqual({
    action: 'error',
    message: '--agent requires a value',
  });
  expect(parseArgs(['--agent', '--tag', 'report'], dir, HOME)).toEqual({
    action: 'error',
    message: '--agent requires a value',
  });
});

// Review finding (tg#6254): a whitespace-only value must be REJECTED like a
// missing one — trimming it to '' would otherwise silently fall through to
// TG_AGENT/auto-detection in the entrypoint, breaking "explicit flag wins".
test('--agent rejects a whitespace-only value (not silently emptied)', () => {
  expect(parseArgs(['--agent', '   ', 'body'], dir, HOME)).toEqual({
    action: 'error',
    message: '--agent requires a value',
  });
  expect(parseArgs(['--agent', '\t'], dir, HOME)).toEqual({
    action: 'error',
    message: '--agent requires a value',
  });
});

test('--detect-agent wins anywhere as a dedicated info action', () => {
  expect(parseArgs(['--detect-agent'], dir, HOME)).toEqual({ action: 'detectAgent' });
  expect(parseArgs(['hi', '--detect-agent'], dir, HOME)).toEqual({ action: 'detectAgent' });
});

test('--agent value is trimmed', () => {
  expect(parseArgs(['--agent', '  padded-name  ', 'body'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'body',
    format: 'plain',
    agent: 'padded-name',
  });
});

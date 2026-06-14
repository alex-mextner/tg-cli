import { expect, test } from 'bun:test';
import { detectTicketCodes } from '../features/autolink-tasks/detect';
import {
  buildIssuesQuery,
  parseIssuesResponse,
  probeTickets,
  type RunResult,
  type TicketInfo,
} from '../features/autolink-tasks/linear';
import { applyAutolink, linkifyCodes } from '../features/autolink-tasks/render';
import { markHint, parseHintState, serializeHintState } from '../features/autolink-tasks/state';

// --- Detection ---

test('detect: a bare code is found', () => {
  expect(detectTicketCodes('fixed HYP-576 today')).toEqual(['HYP-576']);
});

test('detect: multiple codes, dedup, first-appearance order', () => {
  expect(detectTicketCodes('ABC-1 then DEF-22, ABC-1 again')).toEqual(['ABC-1', 'DEF-22']);
});

test('detect: punctuation around the code is fine', () => {
  expect(detectTicketCodes('(HYP-576), see HYP-577.')).toEqual(['HYP-576', 'HYP-577']);
});

test('detect: 4-letter prefix is not a code', () => {
  expect(detectTicketCodes('XHYP-576')).toEqual([]);
});

test('detect: trailing alphanumeric disqualifies', () => {
  expect(detectTicketCodes('HYP-576a and HYP-577abc')).toEqual([]);
});

test('detect: lowercase is not a code', () => {
  expect(detectTicketCodes('hyp-576 Hyp-577 hYP-578')).toEqual([]);
});

test('detect: fewer than 3 letters is not a code', () => {
  expect(detectTicketCodes('AB-12 A-1')).toEqual([]);
});

test('detect: codes inside URLs are skipped', () => {
  const text = 'see https://linear.app/glide-vc/issue/HYP-576/some-slug for details';
  expect(detectTicketCodes(text)).toEqual([]);
});

test('detect: URL mention does not shadow a separate plain mention', () => {
  const text = 'HYP-576 (https://linear.app/glide-vc/issue/HYP-576/slug)';
  expect(detectTicketCodes(text)).toEqual(['HYP-576']);
});

test('detect: codes embedded in file-path tokens are not tickets', () => {
  expect(detectTicketCodes('see HYP-123.ts:10 and src/HYP-124/x.ts')).toEqual([]);
  expect(detectTicketCodes('lib/HYP-125.test.ts broke')).toEqual([]);
});

test('detect: sentence punctuation after a code still counts', () => {
  expect(detectTicketCodes('fixed HYP-576.')).toEqual(['HYP-576']);
  expect(detectTicketCodes('fixed HYP-576. Next up')).toEqual(['HYP-576']);
});

test('detect: multiline text', () => {
  expect(detectTicketCodes('line one ABC-9\nline two DEF-10')).toEqual(['ABC-9', 'DEF-10']);
});

test('detect: empty and code-free text', () => {
  expect(detectTicketCodes('')).toEqual([]);
  expect(detectTicketCodes('no tickets here, just 3-2 numbers')).toEqual([]);
});

// --- GraphQL query building ---

test('query: groups codes by team key with numbers in', () => {
  const q = buildIssuesQuery(['HYP-576', 'HYP-99999', 'ABC-1']);
  expect(q).toContain('key: { eq: "HYP" }');
  expect(q).toContain('number: { in: [576, 99999] }');
  expect(q).toContain('key: { eq: "ABC" }');
  expect(q).toContain('number: { in: [1] }');
  expect(q).toContain('identifier title url');
});

test('query: absurdly long numbers are dropped', () => {
  const q = buildIssuesQuery(['HYP-12345678901234567890', 'HYP-5']);
  expect(q).toContain('number: { in: [5] }');
  expect(q).not.toContain('12345678901234567890');
});

// --- Response parsing ---

const goodResponse = JSON.stringify({
  data: {
    issues: {
      nodes: [
        { identifier: 'HYP-576', title: 'Fix the thing', url: 'https://linear.app/x/issue/HYP-576/slug' },
        { identifier: 'ZZZ-1', title: 'Unrelated', url: 'https://linear.app/x/issue/ZZZ-1/slug' },
      ],
    },
  },
});

test('parse: returns only wanted identifiers', () => {
  const map = parseIssuesResponse(goodResponse, ['HYP-576', 'HYP-999']);
  expect(map).not.toBeNull();
  expect(map!.get('HYP-576')).toEqual({
    code: 'HYP-576',
    title: 'Fix the thing',
    url: 'https://linear.app/x/issue/HYP-576/slug',
  });
  expect(map!.has('ZZZ-1')).toBe(false);
  expect(map!.has('HYP-999')).toBe(false);
});

test('parse: malformed JSON / missing data → null', () => {
  expect(parseIssuesResponse('not json', ['HYP-1'])).toBeNull();
  expect(parseIssuesResponse('{"errors":[{"message":"boom"}],"data":null}', ['HYP-1'])).toBeNull();
});

// --- probeTickets (injected runner) ---

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' });

test('probe: spawn failure → no-cli', () => {
  const probe = probeTickets(['HYP-1'], () => null);
  expect(probe.status).toBe('no-cli');
});

test('probe: "No API key configured" → no-auth', () => {
  const probe = probeTickets(['HYP-1'], () => ({
    exitCode: 1,
    stdout: '',
    stderr:
      '✗ API request failed: No API key configured\n  Set LINEAR_API_KEY, add api_key to .linear.toml, or run `linear auth login`.',
  }));
  expect(probe.status).toBe('no-auth');
});

test('probe: "No workspaces configured" → no-auth', () => {
  const probe = probeTickets(['HYP-1'], () => ({
    exitCode: 1,
    stdout: 'No workspaces configured\nRun `linear auth login` to add a workspace',
    stderr: '',
  }));
  expect(probe.status).toBe('no-auth');
});

test('probe: other non-zero exit → error', () => {
  const probe = probeTickets(['HYP-1'], () => ({ exitCode: 1, stdout: '', stderr: 'network sadness' }));
  expect(probe.status).toBe('error');
});

test('probe: retries one unexpected linear failure before degrading', () => {
  const seen: string[][] = [];
  const probe = probeTickets(['HYP-576'], (args) => {
    seen.push(args);
    if (seen.length === 1) return { exitCode: 1, stdout: '', stderr: 'network sadness' };
    return ok(goodResponse);
  });

  expect(probe.status).toBe('ok');
  if (probe.status === 'ok') {
    expect(probe.tickets.get('HYP-576')?.title).toBe('Fix the thing');
  }
  expect(seen).toHaveLength(2);
  expect(seen[1]).toEqual(seen[0]);
});

test('probe: success → ok with the ticket map', () => {
  const probe = probeTickets(['HYP-576'], () => ok(goodResponse));
  expect(probe.status).toBe('ok');
  if (probe.status === 'ok') {
    expect(probe.tickets.get('HYP-576')?.title).toBe('Fix the thing');
  }
});

test('probe: success with unparseable stdout → error', () => {
  const probe = probeTickets(['HYP-1'], () => ok('garbage'));
  expect(probe.status).toBe('error');
});

test('probe: all codes gated out (>9 digits) → ok empty map, runner never called', () => {
  let called = false;
  const probe = probeTickets(['HYP-12345678901234567890'], () => {
    called = true;
    return ok(goodResponse);
  });
  expect(probe.status).toBe('ok');
  if (probe.status === 'ok') expect(probe.tickets.size).toBe(0);
  expect(called).toBe(false);
});

test('probe: runner receives an api invocation with the query', () => {
  let seen: string[] = [];
  probeTickets(['HYP-576'], (args) => {
    seen = args;
    return ok(goodResponse);
  });
  expect(seen[0]).toBe('api');
  expect(seen[1]).toContain('HYP');
});

// --- Linkify ---

const T = (code: string, title = `Title of ${code}`): TicketInfo => ({
  code,
  title,
  url: `https://linear.app/x/issue/${code}/slug`,
});

const mapOf = (...tickets: TicketInfo[]): Map<string, TicketInfo> => new Map(tickets.map((t) => [t.code, t]));

test('linkify: wraps a verified code in an anchor', () => {
  const out = linkifyCodes('done with HYP-576 today', mapOf(T('HYP-576')));
  expect(out).toBe('done with <a href="https://linear.app/x/issue/HYP-576/slug">HYP-576</a> today');
});

test('linkify: every occurrence is linked', () => {
  const out = linkifyCodes('HYP-1 first, HYP-1 second', mapOf(T('HYP-1')));
  expect(out.match(/<a /g)?.length).toBe(2);
});

test('linkify: unverified codes stay plain', () => {
  const out = linkifyCodes('HYP-1 and XXX-9', mapOf(T('HYP-1')));
  expect(out).toContain('<a ');
  expect(out).not.toContain('XXX-9</a>');
});

test('linkify: skips tokens containing ://', () => {
  const text = 'https://linear.app/x/issue/HYP-576/slug';
  expect(linkifyCodes(text, mapOf(T('HYP-576')))).toBe(text);
});

test('linkify: never nests inside an existing <a>', () => {
  const text = '<a href="https://x.test/">about HYP-576 here</a>';
  expect(linkifyCodes(text, mapOf(T('HYP-576')))).toBe(text);
});

test('linkify: skips <pre> and <code> content', () => {
  const text = '<pre>HYP-576</pre> and <code>HYP-576</code> but HYP-576 outside';
  const out = linkifyCodes(text, mapOf(T('HYP-576')));
  expect(out).toContain('<pre>HYP-576</pre>');
  expect(out).toContain('<code>HYP-576</code>');
  expect(out.match(/<a /g)?.length).toBe(1);
});

test('linkify: never rewrites inside tag attributes', () => {
  const text = '<a href="https://x.test/HYP-576">link</a> HYP-576';
  const out = linkifyCodes(text, mapOf(T('HYP-576')));
  expect(out).toContain('href="https://x.test/HYP-576"');
  expect(out.match(/<a /g)?.length).toBe(2);
});

test('linkify: boundary rules match detection (no XHYP-576, no HYP-576a)', () => {
  const out = linkifyCodes('XHYP-576 HYP-576a', mapOf(T('HYP-576')));
  expect(out).not.toContain('<a ');
});

test('linkify: a line-spec path token stays contiguous (quote anchor safety)', () => {
  const text = 'see HYP-576.ts:10 for the bug';
  expect(linkifyCodes(text, mapOf(T('HYP-576')))).toBe(text);
});

test('linkify: escapes &, <, " in the href attribute', () => {
  const out = linkifyCodes('HYP-1', mapOf({ code: 'HYP-1', title: 't', url: 'https://x.test/?a=1&b="2"' }));
  expect(out).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
});

// --- applyAutolink ---

test('single ticket + prefix line: title appended to the first line', () => {
  const body = '✳️ [tg-cli]\nshipped HYP-576';
  const out = applyAutolink(body, [T('HYP-576', 'Fix the thing')], true);
  const lines = out.split('\n');
  expect(lines[0]).toBe('✳️ [tg-cli] Fix the thing');
  expect(lines[1]).toContain('<a href="https://linear.app/x/issue/HYP-576/slug">HYP-576</a>');
});

test('single ticket, no prefix: title becomes its own first line', () => {
  const out = applyAutolink('shipped HYP-576', [T('HYP-576', 'Fix the thing')], false);
  const lines = out.split('\n');
  expect(lines[0]).toBe('Fix the thing');
  expect(lines[1]).toContain('HYP-576</a>');
});

test('single ticket: title is HTML-escaped', () => {
  const out = applyAutolink('HYP-5', [T('HYP-5', 'a <b> & c')], false);
  expect(out.split('\n')[0]).toBe('a &lt;b&gt; &amp; c');
});

test('multiple tickets: collapsed quote appended with code: title lines', () => {
  const body = '✳️ [w]\nHYP-1 blocks HYP-2';
  const out = applyAutolink(body, [T('HYP-1', 'First'), T('HYP-2', 'Second & last')], true);
  // First line untouched (no single-ticket title).
  expect(out.split('\n')[0]).toBe('✳️ [w]');
  expect(out).toContain('<blockquote expandable>');
  expect(out).toContain('<a href="https://linear.app/x/issue/HYP-1/slug">HYP-1</a>: First');
  expect(out).toContain('<a href="https://linear.app/x/issue/HYP-2/slug">HYP-2</a>: Second &amp; last');
  expect(out.trimEnd().endsWith('</blockquote>')).toBe(true);
});

test('multiple tickets: codes in the body are still linkified', () => {
  const out = applyAutolink('HYP-1 blocks HYP-2', [T('HYP-1'), T('HYP-2')], false);
  const bodyPart = out.split('<blockquote')[0];
  expect(bodyPart.match(/<a /g)?.length).toBe(2);
});

test('no tickets: body returned unchanged', () => {
  expect(applyAutolink('hello', [], false)).toBe('hello');
});

// --- Hint state ---

test('state: garbage and null parse to empty', () => {
  expect(parseHintState(null)).toEqual({});
  expect(parseHintState('not json')).toEqual({});
  expect(parseHintState('[1,2]')).toEqual({});
});

test('state: mark + serialize roundtrip', () => {
  const s1 = markHint(parseHintState(null), 'install');
  expect(s1.install).toBe(true);
  const s2 = parseHintState(serializeHintState(markHint(s1, 'login')));
  expect(s2).toEqual({ install: true, login: true });
});

test('state: existing keys survive a parse', () => {
  expect(parseHintState('{"install":true}')).toEqual({ install: true });
});

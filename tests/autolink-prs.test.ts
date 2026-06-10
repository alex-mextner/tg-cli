import { expect, test } from 'bun:test';
import { detectRefs, findRefMatches } from '../features/autolink-prs/detect';
import {
  buildRefsQuery,
  parseRefsResponse,
  probeRefs,
  probeRefsInRepo,
  probeRepo,
  type GhRef,
  type RunResult,
} from '../features/autolink-prs/resolve';
import { CACHE_TTL_MS, cacheKey, mergeIntoCache, splitByCache } from '../features/autolink-prs/cache';
import { buildEntries, linkifyRefs, prStateSuffix, refAnchor } from '../features/autolink-prs/render';
import { applyAutolink, type TicketInfo } from '../features/autolink-tasks/render';
import { parseHintState, serializeHintState, markHint } from '../features/autolink-tasks/state';

// --- Detection ---

test('detect: a bare ref is found', () => {
  expect(detectRefs('fixes #260 today')).toEqual([260]);
});

test('detect: multiple refs, dedup by number, first-appearance order', () => {
  expect(detectRefs('#1 then #22, #1 again')).toEqual([1, 22]);
});

test('detect: punctuation around the ref is fine', () => {
  expect(detectRefs('(#260), see #261. and #262,')).toEqual([260, 261, 262]);
});

test('detect: a leading alphanumeric disqualifies', () => {
  expect(detectRefs('x#1 and abc#42')).toEqual([]);
});

test('detect: a trailing alphanumeric disqualifies', () => {
  expect(detectRefs('#1a #42x')).toEqual([]);
});

test('detect: #0 is not a ref (must be [1-9]\\d*)', () => {
  expect(detectRefs('#0 and #00')).toEqual([]);
});

test('detect: refs inside URLs are skipped', () => {
  expect(detectRefs('see https://github.com/o/r/pull/260 for details')).toEqual([]);
});

test('detect: URL mention does not shadow a separate plain mention', () => {
  expect(detectRefs('#260 (https://github.com/o/r/pull/260)')).toEqual([260]);
});

test('detect: a bare # or #word is not a ref', () => {
  expect(detectRefs('# heading and #feature-branch')).toEqual([]);
});

test('detect: multiline text', () => {
  expect(detectRefs('line one #9\nline two #10')).toEqual([9, 10]);
});

test('detect: empty and ref-free text', () => {
  expect(detectRefs('')).toEqual([]);
  expect(detectRefs('no refs here, just 3-2 numbers')).toEqual([]);
});

test('findRefMatches: returns start/end/number triples', () => {
  expect(findRefMatches('(#260)')).toEqual([{ start: 1, end: 5, number: 260 }]);
});

// --- GraphQL query building ---

test('query: aliases each number with issueOrPullRequest fragments', () => {
  const q = buildRefsQuery('alex-mextner', 'tg-cli', [260, 42]);
  expect(q).toContain('repository(owner: "alex-mextner", name: "tg-cli")');
  expect(q).toContain('n260: issueOrPullRequest(number: 260)');
  expect(q).toContain('n42: issueOrPullRequest(number: 42)');
  expect(q).toContain('__typename');
  expect(q).toContain('... on Issue { number title url state }');
  expect(q).toContain('... on PullRequest { number title url state isDraft }');
});

test('query: owner/name are JSON-escaped (no injection through quotes)', () => {
  const q = buildRefsQuery('o"x', 'r', [1]);
  expect(q).toContain('owner: "o\\"x"');
});

// --- Response parsing ---

const prNode = (n: number) => ({
  __typename: 'PullRequest',
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  state: 'MERGED',
  isDraft: false,
});
const issueNode = (n: number) => ({
  __typename: 'Issue',
  number: n,
  title: `Issue ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
  state: 'OPEN',
});

test('parse: resolves issues and PRs with the right kind', () => {
  const raw = JSON.stringify({ data: { repository: { n260: prNode(260), n42: issueNode(42) } } });
  const map = parseRefsResponse(raw, [260, 42]);
  expect(map).not.toBeNull();
  expect(map!.get(260)?.kind).toBe('pr');
  expect(map!.get(260)?.isDraft).toBe(false);
  expect(map!.get(42)?.kind).toBe('issue');
  expect(map!.get(42)?.title).toBe('Issue 42');
});

test('parse: partial response (null alias + top-level errors) keeps present refs', () => {
  // gh returns this for a mix of existing and missing numbers.
  const raw = JSON.stringify({
    data: { repository: { n260: prNode(260), n999: null } },
    errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node with number 999' }],
  });
  const map = parseRefsResponse(raw, [260, 999]);
  expect(map).not.toBeNull();
  expect(map!.has(260)).toBe(true);
  expect(map!.has(999)).toBe(false);
});

test('parse: only wanted numbers are kept', () => {
  const raw = JSON.stringify({ data: { repository: { n260: prNode(260), n5: issueNode(5) } } });
  const map = parseRefsResponse(raw, [260]);
  expect(map!.has(260)).toBe(true);
  expect(map!.has(5)).toBe(false);
});

test('parse: malformed JSON / repository null → null', () => {
  expect(parseRefsResponse('not json', [1])).toBeNull();
  expect(parseRefsResponse('{"data":{"repository":null}}', [1])).toBeNull();
  expect(parseRefsResponse('{"errors":[{"message":"boom"}],"data":null}', [1])).toBeNull();
});

// --- probeRepo / probeRefsInRepo / probeRefs (injected runner) ---

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' });

test('probeRepo: spawn failure → no-cli', () => {
  expect(probeRepo(() => null).status).toBe('no-cli');
});

test('probeRepo: success returns owner/name', () => {
  const p = probeRepo(() => ok('alex-mextner/tg-cli\n'));
  expect(p).toEqual({ status: 'ok', repo: 'alex-mextner/tg-cli' });
});

test('probeRepo: auth error → no-auth', () => {
  const p = probeRepo(() => ({ exitCode: 1, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login' }));
  expect(p.status).toBe('no-auth');
});

test('probeRepo: not a git repo → no-repo', () => {
  const p = probeRepo(() => ({ exitCode: 1, stdout: '', stderr: 'not a git repository' }));
  expect(p.status).toBe('no-repo');
});

test('probeRepo: any unclassified failure → no-repo (silent, common case)', () => {
  const p = probeRepo(() => ({ exitCode: 1, stdout: '', stderr: 'something weird' }));
  expect(p.status).toBe('no-repo');
});

test('probeRepo: empty stdout on exit 0 → no-repo', () => {
  expect(probeRepo(() => ok('')).status).toBe('no-repo');
});

test('probeRefsInRepo: empty numbers → ok empty, runner never called', () => {
  let called = false;
  const p = probeRefsInRepo('o/r', [], () => {
    called = true;
    return ok('');
  });
  expect(p.status).toBe('ok');
  expect(called).toBe(false);
});

test('probeRefsInRepo: success returns the refs map', () => {
  const raw = JSON.stringify({ data: { repository: { n260: prNode(260) } } });
  const p = probeRefsInRepo('o/r', [260], () => ok(raw));
  expect(p.status).toBe('ok');
  if (p.status === 'ok') expect(p.refs.get(260)?.kind).toBe('pr');
});

test('probeRefsInRepo: partial errors with non-zero exit still parse → ok', () => {
  const raw = JSON.stringify({
    data: { repository: { n260: prNode(260), n999: null } },
    errors: [{ message: 'missing 999' }],
  });
  const p = probeRefsInRepo('o/r', [260, 999], () => ({ exitCode: 1, stdout: raw, stderr: 'gql error' }));
  expect(p.status).toBe('ok');
  if (p.status === 'ok') {
    expect(p.refs.has(260)).toBe(true);
    expect(p.refs.has(999)).toBe(false);
  }
});

test('probeRefsInRepo: unparseable body + non-zero exit → error', () => {
  const p = probeRefsInRepo('o/r', [1], () => ({ exitCode: 1, stdout: 'garbage', stderr: 'boom' }));
  expect(p.status).toBe('error');
});

test('probeRefsInRepo: graphql receives the api invocation with the query', () => {
  let seen: string[] = [];
  probeRefsInRepo('o/r', [260], (args) => {
    seen = args;
    return ok(JSON.stringify({ data: { repository: { n260: prNode(260) } } }));
  });
  expect(seen[0]).toBe('api');
  expect(seen[1]).toBe('graphql');
  expect(seen[2]).toBe('-f');
  expect(seen[3]).toContain('query=');
  expect(seen[3]).toContain('n260');
});

test('probeRefs: composes repo + refs in two spawns', () => {
  const calls: string[][] = [];
  const p = probeRefs([260], (args) => {
    calls.push(args);
    if (args[0] === 'repo') return ok('o/r\n');
    return ok(JSON.stringify({ data: { repository: { n260: prNode(260) } } }));
  });
  expect(p.status).toBe('ok');
  if (p.status === 'ok') {
    expect(p.repo).toBe('o/r');
    expect(p.refs.get(260)?.kind).toBe('pr');
  }
  expect(calls.length).toBe(2);
});

test('probeRefs: repo failure short-circuits before graphql', () => {
  const calls: string[][] = [];
  const p = probeRefs([260], (args) => {
    calls.push(args);
    return { exitCode: 1, stdout: '', stderr: 'not a git repository' };
  });
  expect(p.status).toBe('no-repo');
  expect(calls.length).toBe(1);
});

// --- Cache (repo-keyed) ---

const T0 = 1_750_000_000_000;
const REPO = 'alex-mextner/tg-cli';
const ref = (n: number, kind: 'issue' | 'pr' = 'pr'): GhRef => ({
  number: n,
  kind,
  title: `Title ${n}`,
  url: `https://github.com/o/r/${kind === 'pr' ? 'pull' : 'issues'}/${n}`,
  state: kind === 'pr' ? 'MERGED' : 'OPEN',
});
const rawWith = (entries: Record<string, { t: number; info: GhRef | null }>): string =>
  JSON.stringify({ entries });

test('cache: key includes the repo', () => {
  expect(cacheKey(REPO, 260)).toBe('alex-mextner/tg-cli#260');
});

test('cache: same number in a different repo is a different entry (miss)', () => {
  const raw = rawWith({ [cacheKey('owner-a/repo', 260)]: { t: T0 - 1000, info: ref(260) } });
  // Lookup under a DIFFERENT repo must miss — the bug this key shape prevents.
  const { hits, missing } = splitByCache('owner-b/repo', [260], raw, T0);
  expect(hits.size).toBe(0);
  expect(missing).toEqual([260]);
});

test('cache: fresh positive entry is a hit', () => {
  const raw = rawWith({ [cacheKey(REPO, 260)]: { t: T0 - 1000, info: ref(260) } });
  const { hits, missing } = splitByCache(REPO, [260], raw, T0);
  expect(hits.get(260)?.title).toBe('Title 260');
  expect(missing).toEqual([]);
});

test('cache: fresh negative entry is a hit (verified-absent)', () => {
  const raw = rawWith({ [cacheKey(REPO, 999)]: { t: T0 - 1000, info: null } });
  const { hits, missing } = splitByCache(REPO, [999], raw, T0);
  expect(hits.has(999)).toBe(true);
  expect(hits.get(999)).toBeNull();
  expect(missing).toEqual([]);
});

test('cache: expired entry is missing (TTL boundary inclusive)', () => {
  const raw = rawWith({ [cacheKey(REPO, 1)]: { t: T0 - CACHE_TTL_MS, info: ref(1) } });
  expect(splitByCache(REPO, [1], raw, T0).missing).toEqual([1]);
});

test('cache: empty repo identity → everything missing', () => {
  const raw = rawWith({ [cacheKey(REPO, 1)]: { t: T0 - 1, info: ref(1) } });
  expect(splitByCache('', [1], raw, T0).missing).toEqual([1]);
});

test('cache: null / corrupt raw → everything missing', () => {
  for (const raw of [null, 'garbage', '[1]', '{"entries":"nope"}']) {
    const { hits, missing } = splitByCache(REPO, [1, 2], raw, T0);
    expect(hits.size).toBe(0);
    expect(missing).toEqual([1, 2]);
  }
});

test('cache merge: probed numbers get positive entries, absent ones negative', () => {
  const refs = new Map([[260, ref(260)]]);
  const raw = mergeIntoCache(null, REPO, [260, 999], refs, T0);
  const { hits, missing } = splitByCache(REPO, [260, 999], raw, T0 + 1000);
  expect(hits.get(260)?.url).toContain('260');
  expect(hits.get(999)).toBeNull();
  expect(missing).toEqual([]);
});

test('cache merge: keeps fresh unrelated entries, prunes expired', () => {
  const old = rawWith({
    [cacheKey(REPO, 1)]: { t: T0 - CACHE_TTL_MS - 5000, info: ref(1) },
    [cacheKey(REPO, 2)]: { t: T0 - 1000, info: ref(2) },
  });
  const raw = mergeIntoCache(old, REPO, [260], new Map([[260, ref(260)]]), T0);
  const parsed = JSON.parse(raw) as { entries: Record<string, unknown> };
  expect(Object.keys(parsed.entries).sort()).toEqual(
    [cacheKey(REPO, 2), cacheKey(REPO, 260)].sort(),
  );
});

test('cache merge: corrupt info shape in old raw is dropped', () => {
  const old = JSON.stringify({ entries: { [cacheKey(REPO, 1)]: { t: T0, info: { number: 1 } } } });
  const { hits, missing } = splitByCache(REPO, [1], old, T0 + 1);
  expect(hits.size).toBe(0);
  expect(missing).toEqual([1]);
});

test('cache: a positive entry missing string state is a miss (no render crash)', () => {
  // A hand-edited/torn entry without `state` must not survive parsing — the
  // render path calls ref.state.toUpperCase() and would crash a real send.
  const old = JSON.stringify({
    entries: {
      [cacheKey(REPO, 1)]: {
        t: T0,
        info: { number: 1, kind: 'pr', title: 't', url: 'https://x.test/1' },
      },
    },
  });
  const { hits, missing } = splitByCache(REPO, [1], old, T0 + 1);
  expect(hits.size).toBe(0);
  expect(missing).toEqual([1]);
});

// --- linkifyRefs ---

const refsMap = (...refs: GhRef[]): Map<number, GhRef> => new Map(refs.map((r) => [r.number, r]));

test('linkify: wraps a verified ref in an anchor', () => {
  const out = linkifyRefs('done with #260 today', refsMap(ref(260)));
  expect(out).toBe('done with <a href="https://github.com/o/r/pull/260">#260</a> today');
});

test('linkify: every occurrence is linked', () => {
  const out = linkifyRefs('#1 first, #1 second', refsMap(ref(1)));
  expect(out.match(/<a /g)?.length).toBe(2);
});

test('linkify: unverified refs stay plain', () => {
  const out = linkifyRefs('#1 and #999', refsMap(ref(1)));
  expect(out).toContain('>#1</a>');
  expect(out).not.toContain('>#999</a>');
});

test('linkify: skips tokens containing ://', () => {
  const text = 'https://github.com/o/r/pull/260';
  expect(linkifyRefs(text, refsMap(ref(260)))).toBe(text);
});

test('linkify: never nests inside an existing <a>', () => {
  const text = '<a href="https://x.test/">about #260 here</a>';
  expect(linkifyRefs(text, refsMap(ref(260)))).toBe(text);
});

test('linkify: skips <pre> and <code> content', () => {
  const text = '<pre>#260</pre> and <code>#260</code> but #260 outside';
  const out = linkifyRefs(text, refsMap(ref(260)));
  expect(out).toContain('<pre>#260</pre>');
  expect(out).toContain('<code>#260</code>');
  expect(out.match(/<a /g)?.length).toBe(1);
});

test('linkify: boundary rules match detection (no x#260, no #260a)', () => {
  const out = linkifyRefs('x#260 #260a', refsMap(ref(260)));
  expect(out).not.toContain('<a ');
});

// --- prStateSuffix / refAnchor ---

test('prStateSuffix: state annotations', () => {
  expect(prStateSuffix(ref(1))).toBe(' (merged)');
  expect(prStateSuffix({ ...ref(2), state: 'CLOSED' })).toBe(' (closed)');
  expect(prStateSuffix({ ...ref(3), state: 'OPEN', isDraft: true })).toBe(' (draft)');
  expect(prStateSuffix({ ...ref(4), state: 'OPEN', isDraft: false })).toBe(' (open)');
});

test('refAnchor: escapes the href', () => {
  const out = refAnchor({ ...ref(1), url: 'https://x.test/?a=1&b="2"' });
  expect(out).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
});

// --- buildEntries ---

test('buildEntries: splits issues and PRs in first-appearance order', () => {
  const map = refsMap(ref(260, 'pr'), ref(42, 'issue'), ref(7, 'pr'));
  const { issues, prs } = buildEntries(map, [260, 42, 7]);
  expect(issues.length).toBe(1);
  expect(issues[0].label).toContain('>#42</a>');
  expect(prs.map((p) => p.label)).toEqual(['<a href="https://github.com/o/r/pull/260">#260</a>', '<a href="https://github.com/o/r/pull/7">#7</a>']);
});

// --- Composition through applyAutolink (the real render path) ---

const T = (code: string, title = `Title ${code}`): TicketInfo => ({
  code,
  title,
  url: `https://linear.app/x/issue/${code}/slug`,
});

const linkifyWith = (map: Map<number, GhRef>) => (html: string): string => linkifyRefs(html, map);

test('render: a single PR gets its own block even alone', () => {
  const map = refsMap(ref(260, 'pr'));
  const { issues, prs } = buildEntries(map, [260]);
  const out = applyAutolink('shipped #260', [], false, { linkify: linkifyWith(map), issues, prs });
  expect(out).toContain('<a href="https://github.com/o/r/pull/260">#260</a>');
  expect(out).toContain('<blockquote expandable>PRs:\n');
  expect(out).toContain('#260</a> — Title 260 (merged)');
  expect(out.trimEnd().endsWith('</blockquote>')).toBe(true);
});

test('render: multiple PRs in one block, first-appearance order', () => {
  const map = refsMap(ref(7, 'pr'), ref(8, 'pr'));
  const { issues, prs } = buildEntries(map, [7, 8]);
  const out = applyAutolink('#7 and #8', [], false, { linkify: linkifyWith(map), issues, prs });
  const prBlock = out.slice(out.indexOf('PRs:'));
  expect(prBlock.indexOf('#7')).toBeLessThan(prBlock.indexOf('#8'));
});

test('render: an issue merges into the tickets block (no first-line title)', () => {
  const map = refsMap(ref(42, 'issue'));
  const { issues, prs } = buildEntries(map, [42]);
  const out = applyAutolink('HYP-1 and #42', [T('HYP-1', 'My ticket')], true, {
    linkify: linkifyWith(map),
    issues,
    prs,
  });
  // Both in the SAME blockquote, ticket first then issue.
  const block = out.slice(out.indexOf('<blockquote'));
  expect(block).toContain('HYP-1</a>: My ticket');
  expect(block).toContain('#42</a> — Title 42');
  expect((out.match(/<blockquote expandable>/g) ?? []).length).toBe(1);
  // The single ticket did NOT ride the first line (an issue forced the block).
  expect(out.split('\n')[0]).not.toContain('My ticket');
});

test('render: single ticket with no issues keeps first-line title behavior', () => {
  const out = applyAutolink('shipped HYP-1', [T('HYP-1', 'My ticket')], false);
  expect(out.split('\n')[0]).toBe('My ticket');
});

test('render: mixed ticket + issue + PR — tickets/issues block THEN PRs block', () => {
  const map = refsMap(ref(42, 'issue'), ref(260, 'pr'));
  const { issues, prs } = buildEntries(map, [42, 260]);
  const out = applyAutolink('HYP-1 fixes #42 via #260', [T('HYP-1')], false, {
    linkify: linkifyWith(map),
    issues,
    prs,
  });
  const firstBlock = out.indexOf('<blockquote expandable>');
  const prsBlock = out.indexOf('<blockquote expandable>PRs:');
  expect(firstBlock).toBeGreaterThanOrEqual(0);
  expect(prsBlock).toBeGreaterThan(firstBlock);
  // The first block has the ticket and the issue, not the PR.
  const between = out.slice(firstBlock, prsBlock);
  expect(between).toContain('HYP-1');
  expect(between).toContain('#42');
  expect(between).not.toContain('#260</a> — ');
  // All three are linkified in the body.
  const body = out.slice(0, firstBlock);
  expect(body).toContain('HYP-1</a>');
  expect(body).toContain('#42</a>');
  expect(body).toContain('#260</a>');
});

test('render: no refs/tickets returns body unchanged', () => {
  expect(applyAutolink('hello', [], false, {})).toBe('hello');
});

// --- Hint state backward compat (shared file, gh-* kinds added) ---

test('hint state: old {install,login} file still parses', () => {
  expect(parseHintState('{"install":true,"login":true}')).toEqual({ install: true, login: true });
});

test('hint state: gh kinds roundtrip and coexist with linear kinds', () => {
  let s = parseHintState('{"install":true}');
  s = markHint(s, 'gh-install');
  s = markHint(s, 'gh-login');
  const round = parseHintState(serializeHintState(s));
  expect(round).toEqual({ install: true, 'gh-install': true, 'gh-login': true });
});

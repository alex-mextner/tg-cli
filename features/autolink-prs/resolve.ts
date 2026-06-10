// GitHub gateway for the autolink-prs feature (spec §Verification).
//
// Everything here is PURE except the Runner the caller injects: tests pass a
// fake, the tg entrypoint passes a Bun.spawnSync wrapper run from the send's
// cwd. Two spawns per send — repo identity (`gh repo view`) and one batched
// `gh api graphql` resolving EVERY detected number at once via aliased
// `issueOrPullRequest(number:)` fields. That GraphQL field errors PER-FIELD for
// a missing number, returning a partial `data` object alongside a top-level
// `errors` array, which we treat as "this number is absent" rather than failing
// the whole send. Mirrors features/autolink-tasks/linear.ts.

// A resolved GitHub reference. `kind` decides where it renders: an Issue merges
// into the autolink-tasks ticket block, a PullRequest gets its own block.
export interface GhRef {
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  url: string;
  state: string; // OPEN | CLOSED | MERGED (GraphQL enum, as-is)
  isDraft?: boolean; // PRs only
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// null = the spawn itself failed (binary not found / not executable).
export type Runner = (args: string[]) => RunResult | null;

export type GhProbe =
  | { status: 'ok'; repo: string; refs: Map<number, GhRef> }
  | { status: 'no-cli' }
  | { status: 'no-auth' }
  | { status: 'no-repo' }
  | { status: 'error'; message: string };

// Substrings gh prints when the cwd is not a usable GitHub repo. `gh repo view`
// fails here, which is normal (a non-GitHub cwd) — we degrade silently, no hint.
const NO_REPO_MARKERS = [
  'not a git repository',
  'no git remotes found',
  'none of the git remotes',
  'could not determine',
];

// Substrings gh prints when it is installed but not authenticated.
const NO_AUTH_MARKERS = [
  'gh auth login',
  'not logged into',
  'authentication required',
  'requires authentication',
];

/**
 * Build the batched GraphQL query resolving every number against `owner/name`.
 * Each number becomes an aliased `issueOrPullRequest` field so one missing
 * number only nulls its own alias (partial data), not the whole response.
 */
export function buildRefsQuery(owner: string, name: string, numbers: number[]): string {
  const fields = numbers
    .map(
      (n) =>
        `n${n}: issueOrPullRequest(number: ${n}) { __typename ` +
        `... on Issue { number title url state } ` +
        `... on PullRequest { number title url state isDraft } }`,
    )
    .join(' ');
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
}

/**
 * Parse the `gh api graphql` JSON into a number → GhRef map, keeping only
 * `wanted` numbers. Tolerates partial responses: a `data.repository` object with
 * some null aliases (alongside a top-level `errors` array) resolves the present
 * aliases and drops the null ones. Returns null only when there is no usable
 * `data.repository` object at all (whole-response failure).
 */
export function parseRefsResponse(raw: string, wanted: number[]): Map<number, GhRef> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const repo = (parsed as { data?: { repository?: unknown } })?.data?.repository;
  if (repo === null || typeof repo !== 'object') return null;
  const wantedSet = new Set(wanted);
  const map = new Map<number, GhRef>();
  for (const value of Object.values(repo as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const v = value as {
      __typename?: unknown;
      number?: unknown;
      title?: unknown;
      url?: unknown;
      state?: unknown;
      isDraft?: unknown;
    };
    if (typeof v.number !== 'number' || typeof v.title !== 'string' || typeof v.url !== 'string') {
      continue;
    }
    if (!wantedSet.has(v.number)) continue;
    const kind = v.__typename === 'PullRequest' ? 'pr' : 'issue';
    const ref: GhRef = {
      number: v.number,
      kind,
      title: v.title,
      url: v.url,
      state: typeof v.state === 'string' ? v.state : '',
    };
    if (kind === 'pr') ref.isDraft = v.isDraft === true;
    map.set(v.number, ref);
  }
  return map;
}

function classifyFailure(combined: string): 'no-auth' | 'no-repo' | null {
  const lower = combined.toLowerCase();
  if (NO_AUTH_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return 'no-auth';
  if (NO_REPO_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return 'no-repo';
  return null;
}

/**
 * Resolve the cwd repo's `owner/name` via `gh repo view`. Returns a probe status
 * on failure so the caller can short-circuit without spawning the graphql query.
 */
export function probeRepo(run: Runner): { status: 'ok'; repo: string } | Exclude<GhProbe, { status: 'ok' }> {
  const result = run(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (result === null) return { status: 'no-cli' };
  const combined = `${result.stdout}\n${result.stderr}`;
  const failure = classifyFailure(combined);
  if (failure === 'no-auth') return { status: 'no-auth' };
  if (result.exitCode !== 0) {
    // gh repo view fails outside a GitHub repo; that is the common case, treat
    // an unclassified failure as no-repo (silent) rather than a loud error.
    return { status: failure === 'no-repo' ? 'no-repo' : 'no-repo' };
  }
  const repo = result.stdout.trim();
  if (!repo || !repo.includes('/')) return { status: 'no-repo' };
  return { status: 'ok', repo };
}

// The graphql-only half of a probe, run against a KNOWN repo. Split out so the
// caller can resolve repo identity once (for the cache key), split detected
// numbers by the repo-keyed cache, and only spawn the graphql query for the
// numbers that actually missed the cache.
export type GhRefsResult =
  | { status: 'ok'; refs: Map<number, GhRef> }
  | { status: 'no-cli' }
  | { status: 'no-auth' }
  | { status: 'error'; message: string };

export function probeRefsInRepo(repo: string, numbers: number[], run: Runner): GhRefsResult {
  if (numbers.length === 0) return { status: 'ok', refs: new Map() };
  const [owner, name] = repo.split('/');
  const result = run(['api', 'graphql', '-f', `query=${buildRefsQuery(owner, name, numbers)}`]);
  if (result === null) return { status: 'no-cli' };
  const combined = `${result.stdout}\n${result.stderr}`;
  const failure = classifyFailure(combined);
  if (failure === 'no-auth') return { status: 'no-auth' };
  // exitCode may be non-zero when SOME numbers are missing (partial data +
  // top-level errors). Only treat it as an error when the body has no usable
  // repository object to parse.
  const refs = parseRefsResponse(result.stdout, numbers);
  if (refs === null) {
    if (result.exitCode !== 0) {
      return { status: 'error', message: result.stderr.trim() || `gh exited ${result.exitCode}` };
    }
    return { status: 'error', message: 'unexpected gh api graphql response' };
  }
  return { status: 'ok', refs };
}

/**
 * Verify `numbers` against the cwd GitHub repo in two CLI spawns (repo identity,
 * then a single batched graphql). Never throws; every failure mode is a distinct
 * status so the caller can hint (no-cli/no-auth), stay silent (no-repo), warn
 * (error), or proceed (ok). Convenience wrapper for callers that don't cache.
 */
export function probeRefs(numbers: number[], run: Runner): GhProbe {
  if (numbers.length === 0) return { status: 'ok', repo: '', refs: new Map() };
  const repoProbe = probeRepo(run);
  if (repoProbe.status !== 'ok') return repoProbe;
  const { repo } = repoProbe;
  const result = probeRefsInRepo(repo, numbers, run);
  if (result.status !== 'ok') return result;
  return { status: 'ok', repo, refs: result.refs };
}

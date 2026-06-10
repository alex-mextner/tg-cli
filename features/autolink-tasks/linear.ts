// Linear CLI gateway for the autolink-tasks feature (spec §Verification).
//
// Everything here is PURE except for the Runner the caller injects: tests pass
// a fake, the tg entrypoint passes a Bun.spawnSync wrapper. One spawn verifies
// ALL detected codes via a single GraphQL filter query — the aliased
// issue(id:) form is unusable because one missing issue nulls the whole
// response, while a filter query just omits the missing ones (which is exactly
// the "nonexistent ticket → ignore" behavior the spec wants).

export interface TicketInfo {
  code: string;
  title: string;
  url: string;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// null = the spawn itself failed (binary not found / not executable).
export type Runner = (args: string[]) => RunResult | null;

export type LinearProbe =
  | { status: 'ok'; tickets: Map<string, TicketInfo> }
  | { status: 'no-cli' }
  | { status: 'no-auth' }
  | { status: 'error'; message: string };

// Linear issue numbers are small; anything longer than 9 digits would lose
// precision in parseInt and cannot be a real issue → drop it from the query
// (the code then never resolves, i.e. it is ignored).
const MAX_NUMBER_DIGITS = 9;

/**
 * Build the GraphQL query verifying `codes`: codes grouped by team key, one
 * and-clause per team, numbers matched with `in`. Missing issues simply don't
 * come back in `nodes`.
 */
export function buildIssuesQuery(codes: string[]): string {
  const byTeam = new Map<string, number[]>();
  for (const code of codes) {
    const dash = code.indexOf('-');
    const team = code.slice(0, dash);
    const digits = code.slice(dash + 1);
    if (digits.length > MAX_NUMBER_DIGITS) continue;
    const num = parseInt(digits, 10);
    const list = byTeam.get(team) ?? [];
    if (!list.includes(num)) list.push(num);
    byTeam.set(team, list);
  }
  const clauses = [...byTeam.entries()].map(
    ([team, nums]) =>
      `{ and: [ { team: { key: { eq: "${team}" } } }, { number: { in: [${nums.join(', ')}] } } ] }`,
  );
  return `query { issues(filter: { or: [ ${clauses.join(', ')} ] }, first: 250) { nodes { identifier title url } } }`;
}

/**
 * Parse the `linear api` JSON response into a code → TicketInfo map, keeping
 * only `wanted` identifiers. Returns null when the payload is malformed or
 * carries no data (e.g. {"errors":[...],"data":null}).
 */
export function parseIssuesResponse(raw: string, wanted: string[]): Map<string, TicketInfo> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const nodes = (parsed as { data?: { issues?: { nodes?: unknown } } })?.data?.issues?.nodes;
  if (!Array.isArray(nodes)) return null;
  const wantedSet = new Set(wanted);
  const map = new Map<string, TicketInfo>();
  for (const node of nodes) {
    const n = node as { identifier?: unknown; title?: unknown; url?: unknown };
    if (typeof n.identifier !== 'string' || typeof n.title !== 'string' || typeof n.url !== 'string') {
      continue;
    }
    if (!wantedSet.has(n.identifier)) continue;
    map.set(n.identifier, { code: n.identifier, title: n.title, url: n.url });
  }
  return map;
}

// Substrings the linear CLI prints when it has no credentials. Checked against
// stdout+stderr because the CLI is not consistent about which stream it uses
// ("No workspaces configured" goes to stdout, API-key errors to stderr).
const NO_AUTH_MARKERS = ['No API key configured', 'No workspaces configured'];

/**
 * Verify `codes` against Linear in one CLI spawn. Never throws; every failure
 * mode is a distinct status so the caller can hint (no-cli/no-auth), warn
 * (error), or proceed (ok).
 */
export function probeTickets(codes: string[], run: Runner): LinearProbe {
  // All codes gated out (absurd numbers) → nothing to verify; an empty or-list
  // would be invalid GraphQL, so don't spawn at all.
  const valid = codes.filter((c) => c.length - c.indexOf('-') - 1 <= MAX_NUMBER_DIGITS);
  if (valid.length === 0) return { status: 'ok', tickets: new Map() };
  const args = ['api', buildIssuesQuery(valid)];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run(args);
    if (result === null) return { status: 'no-cli' };
    const combined = `${result.stdout}\n${result.stderr}`;
    if (NO_AUTH_MARKERS.some((marker) => combined.includes(marker))) {
      return { status: 'no-auth' };
    }
    if (result.exitCode !== 0) {
      if (attempt === 0) continue;
      return { status: 'error', message: result.stderr.trim() || `linear exited ${result.exitCode}` };
    }
    const tickets = parseIssuesResponse(result.stdout, codes);
    if (tickets === null) {
      if (attempt === 0) continue;
      return { status: 'error', message: 'unexpected linear api response' };
    }
    return { status: 'ok', tickets };
  }
  return { status: 'error', message: 'unexpected linear api response' };
}

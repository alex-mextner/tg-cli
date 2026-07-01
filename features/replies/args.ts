// `tg replies` argument parser. PURE — the entrypoint passes argv (everything
// after the `replies` token) and acts on the returned discriminated result.
//
// Grammar:  tg replies [user|agent|all] [list | find <query>] [flags]
//   • direction (1st positional): user | agent | all  — DEFAULT `user`
//     ("вспомнить что писал ПОЛЬЗОВАТЕЛЬ" — inbound is the primary purpose).
//   • action    (2nd positional): list (default) | find <query>
//   • flags: -n/--limit N, --full, --json, --regex, --all-sessions,
//            --session <paneId>, --since <date|relative>, --until <date|relative>,
//            -h/--help.

export type Direction = 'user' | 'agent' | 'all';
export type Action = 'list' | 'find';

export interface RepliesQuery {
  kind: 'query';
  direction: Direction;
  action: Action;
  query?: string; // present iff action === 'find'
  limit: number;
  full: boolean;
  json: boolean;
  regex: boolean;
  allSessions: boolean;
  session?: string; // explicit pane scope (--session %N)
  since?: number; // unix seconds lower bound (inclusive), from --since
  until?: number; // unix seconds upper bound (inclusive), from --until
}

export type RepliesArgs = RepliesQuery | { kind: 'help' } | { kind: 'error'; message: string };

const DEFAULT_LIMIT = 20;
const DIRECTIONS: Direction[] = ['user', 'agent', 'all'];

function isDirection(tok: string): tok is Direction {
  return (DIRECTIONS as string[]).includes(tok);
}

// Parse a date/relative string into a unix-seconds timestamp, or return null
// on parse failure. Supported formats:
//   • ISO date:     "2026-06-28"       → midnight UTC of that day
//   • ISO datetime: "2026-06-28T10:00" → that exact UTC moment
//   • Relative:     "3d" / "24h" / "7d" → now minus that many days/hours
export function parseDateArg(value: string, nowSec?: number): number | null {
  const now = nowSec ?? Math.floor(Date.now() / 1000);

  // Relative: <N>d or <N>h
  const relMatch = /^(\d+)(d|h)$/.exec(value);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2] === 'd' ? 86400 : 3600;
    return now - n * unit;
  }

  // ISO datetime: YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS (UTC assumed)
  const dtMatch = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.exec(value);
  if (dtMatch) {
    const ms = Date.parse(value + 'Z'); // append Z to treat as UTC
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  // ISO date: YYYY-MM-DD (midnight UTC)
  const dateMatch = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (dateMatch) {
    const ms = Date.parse(value + 'T00:00:00Z');
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  return null;
}

export function parseRepliesArgs(argv: string[]): RepliesArgs {
  let direction: Direction = 'user';
  let action: Action = 'list';
  let limit = DEFAULT_LIMIT;
  let full = false;
  let json = false;
  let regex = false;
  let allSessions = false;
  let session: string | undefined;
  let since: number | undefined;
  let until: number | undefined;

  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') return { kind: 'help' };
    if (tok === '--full') {
      full = true;
      i += 1;
    } else if (tok === '--json') {
      json = true;
      i += 1;
    } else if (tok === '--regex') {
      regex = true;
      i += 1;
    } else if (tok === '--all-sessions') {
      allSessions = true;
      i += 1;
    } else if (tok === '-n' || tok === '--limit') {
      const v = argv[i + 1];
      if (v === undefined) return { kind: 'error', message: `${tok} requires a number` };
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) return { kind: 'error', message: `invalid limit: ${v}` };
      limit = n;
      i += 2;
    } else if (tok === '--session') {
      const v = argv[i + 1];
      if (v === undefined) return { kind: 'error', message: '--session requires a pane id' };
      session = v;
      i += 2;
    } else if (tok === '--since') {
      const v = argv[i + 1];
      if (v === undefined) return { kind: 'error', message: '--since requires a date (e.g. 2026-06-28 or 3d)' };
      const ts = parseDateArg(v);
      if (ts === null) return { kind: 'error', message: `--since: cannot parse date: ${v}` };
      since = ts;
      i += 2;
    } else if (tok === '--until') {
      const v = argv[i + 1];
      if (v === undefined) return { kind: 'error', message: '--until requires a date (e.g. 2026-06-30 or 1d)' };
      const ts = parseDateArg(v);
      if (ts === null) return { kind: 'error', message: `--until: cannot parse date: ${v}` };
      until = ts;
      i += 2;
    } else if (tok.startsWith('-') && tok !== '-') {
      return { kind: 'error', message: `unknown flag: ${tok}` };
    } else {
      // Non-flag token → positional. Flags may appear anywhere (before, between,
      // or after positionals); the query is the join of the positionals AFTER
      // the action, so a multi-word query needs no quoting. A query token that
      // literally starts with `-` would be read as a flag — quote it or, for a
      // regex, that edge is outside scope (no leading-dash search terms).
      positionals.push(tok);
      i += 1;
    }
  }

  // Reduce positionals: [direction?] [action] [query…]
  let idx = 0;
  if (positionals[idx] !== undefined && isDirection(positionals[idx])) {
    direction = positionals[idx] as Direction;
    idx += 1;
  }
  const actionTok = positionals[idx];
  if (actionTok === undefined) {
    action = 'list';
  } else if (actionTok === 'list') {
    action = 'list';
    idx += 1;
  } else if (actionTok === 'find') {
    action = 'find';
    idx += 1;
  } else {
    return { kind: 'error', message: `unknown action: ${actionTok} (expected list | find)` };
  }

  let query: string | undefined;
  if (action === 'find') {
    const rest = positionals.slice(idx).join(' ').trim();
    if (rest === '') return { kind: 'error', message: 'find requires a query: tg replies find <query>' };
    query = rest;
  } else if (idx < positionals.length) {
    return { kind: 'error', message: `unexpected argument: ${positionals[idx]}` };
  }

  return {
    kind: 'query',
    direction,
    action,
    query,
    limit,
    full,
    json,
    regex,
    allSessions,
    session,
    since,
    until,
  };
}

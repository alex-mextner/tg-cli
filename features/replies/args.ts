// `tg replies` argument parser. PURE — the entrypoint passes argv (everything
// after the `replies` token) and acts on the returned discriminated result.
//
// Grammar:  tg replies [user|agent|all] [list | find <query>] [flags]
//   • direction (1st positional): user | agent | all  — DEFAULT `user`
//     ("вспомнить что писал ПОЛЬЗОВАТЕЛЬ" — inbound is the primary purpose).
//   • action    (2nd positional): list (default) | find <query>
//   • flags: -n/--limit N, --full, --json, --regex, --all-sessions,
//            --session <paneId>, -h/--help.

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
}

export type RepliesArgs = RepliesQuery | { kind: 'help' } | { kind: 'error'; message: string };

const DEFAULT_LIMIT = 20;
const DIRECTIONS: Direction[] = ['user', 'agent', 'all'];

function isDirection(tok: string): tok is Direction {
  return (DIRECTIONS as string[]).includes(tok);
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
  };
}

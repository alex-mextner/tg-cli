// `tg replies` subcommand handler. Effectful orchestration kept testable via
// dependency injection (the same pattern as features/hooks/cli.ts): the I/O
// (history file read, tmux pane detection, stdout) arrives as `deps` so the
// pure args/select/format modules can be exercised without touching disk/tmux.
//
// Returns an EXIT CODE when it handled `replies`, or null when argv[0] is not
// `replies` (the caller then falls through to the normal send path). Exact-match
// leading token only, so `tg "replies ..."` as a plain message still sends.

import { parseRepliesArgs } from './args';
import { parseHistory } from './history';
import { buildJsonOutput, formatLines, selectHistory } from './select';

export interface RepliesCliDeps {
  // The raw JSONL history blob, or null when the file is absent/unreadable.
  readHistory: () => string | null;
  // The current tmux pane id for default session scoping, or null when not in
  // tmux / undetectable (then the default scope degrades to all-sessions).
  detectPane: () => string | null;
  // Render a unix-seconds timestamp (injected so the entrypoint uses LOCAL time
  // while tests stay deterministic).
  fmtTime: (unixSec: number) => string;
  log: (msg: string) => void;
  errlog: (msg: string) => void;
}

export const REPLIES_USAGE = `Usage: tg replies [user|agent|all] [list | find <query>] [flags]

Recall what was sent over Telegram — by default the messages YOU (the user) sent
in THIS tmux session, oldest first, with timestamps and #message-ids.

Direction (1st positional, default: user):
  user        only messages you sent to the agent (the default)
  agent       only messages the agent sent via tg
  all         both, prefixed ← (you) / → (agent)

Action (2nd positional, default: list):
  list                 recent messages (default)
  find <query>         case-insensitive substring search (add --regex for regex)

Flags:
  -n, --limit <N>      max messages to show (default 20)
  --full               do not truncate long messages (~200 chars otherwise)
  --json               machine-readable JSON array (ts ms, id, direction, from, text, pane)
  --regex              treat the find <query> as a regular expression
  --all-sessions       ignore the current pane; search across every session
  --session <paneId>   scope to a specific tmux pane (e.g. %7)
  --since <date>       only messages at or after this date (inclusive)
  --until <date>       only messages at or before this date (inclusive)
  -h, --help           show this help

Date formats for --since / --until:
  2026-06-28            ISO date (midnight UTC)
  2026-06-28T10:00      ISO datetime (UTC)
  3d / 24h / 7d         relative — N days or hours ago from now

Line format:  [YYYY-MM-DD HH:MM] #<id> <text>
Examples:
  tg replies                               # what you sent in this session
  tg replies all                           # full back-and-forth here
  tg replies user find deploy              # your messages mentioning "deploy"
  tg replies agent --all-sessions          # everything the agent has sent, anywhere
  tg replies user --since 2026-06-28       # your messages from June 28 onward
  tg replies user --since 3d              # your messages in the last 3 days
  tg replies all --since 2026-06-28 --until 2026-06-30  # a date range`;

export function runReplies(argv: string[], deps: RepliesCliDeps): number | null {
  if (argv[0] !== 'replies') return null;

  const parsed = parseRepliesArgs(argv.slice(1));
  if (parsed.kind === 'help') {
    deps.log(REPLIES_USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.errlog(`tg replies: ${parsed.message}`);
    return 1;
  }

  // Resolve the effective pane scope: --all-sessions = no scope; --session wins;
  // otherwise the detected pane (null when undetectable → no scope).
  const pane = parsed.allSessions ? null : (parsed.session ?? deps.detectPane());

  const records = parseHistory(deps.readHistory());

  let selected;
  try {
    selected = selectHistory(records, parsed, pane);
  } catch (err) {
    // The only throw is an invalid regex from searchHistory.
    deps.errlog(`tg replies: invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (parsed.json) {
    deps.log(JSON.stringify(buildJsonOutput(selected)));
    return 0;
  }

  if (selected.length === 0) {
    const scope = pane ? ` in pane ${pane}` : '';
    const what = parsed.action === 'find' ? ` matching "${parsed.query}"` : '';
    deps.log(`no ${parsed.direction === 'all' ? '' : parsed.direction + ' '}messages${what}${scope}.`);
    return 0;
  }

  for (const line of formatLines(selected, {
    direction: parsed.direction,
    full: parsed.full,
    fmtTime: deps.fmtTime,
  })) {
    deps.log(line);
  }
  return 0;
}

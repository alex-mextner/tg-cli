// --- Arg parsing (pure) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 0c, docs/specs/
// tg-decomposition.md). Pure: captures no main() state, all I/O reaches it via
// injected thunks (getWorktreeRoots / getFileIndex) or the real-fs helpers
// below. The entrypoint imports `parseArgs` + the `Format` type from here.
import { readdirSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { isNeverAttach } from '../auto-attach/denylist';
import { parseLineSpec, stripSpecWrappers } from '../auto-attach/snippet';
import { buildFileIndex, isRecursiveCandidate, matchFromIndex, type ListDir } from '../auto-attach/recursive';
import { looksPathLike, resolveAcrossWorktrees } from '../auto-attach/worktree';
import { ESCALATION_TAGS, validateTag } from '../render/tag';
import { detectMsgRefs } from '../autolink-msgrefs/detect';
import { detectTableKind } from '../render/table';

export interface ItemLineSpec {
  // The full original token as written (e.g. "src/a.ts:42-50"), kept so the
  // quote can be anchored on it in the caption.
  token: string;
  startLine: number;
  endLine: number;
  col: number | undefined;
}

export interface Item {
  type: 'photo' | 'document';
  path: string;
  // Present only when the path was written with a trailing line-spec
  // (file.ts:42 / :42-50 / :42:5). Absent otherwise so no-spec parse results
  // are byte-identical to before (keeps existing toEqual assertions green).
  lineSpec?: ItemLineSpec;
  // True ONLY for items DETECTED by the auto-attach path scanner (not for
  // explicit --photo/--file). Marks auto-detected provenance (e.g. the
  // attach-denylist silently skips a denylisted AUTO path but hard-errors an
  // explicit one). Absent on explicit items so their existing toEqual
  // assertions stay byte-identical.
  auto?: true;
}

export type Format = 'plain' | 'html';

export type ParseResult =
  | { action: 'help' }
  | { action: 'version' }
  | { action: 'lsEmojiHelpers' }
  | { action: 'detectModel' }
  | { action: 'detectAgent' }
  | { action: 'formatHelp' }
  | { action: 'error'; message: string }
  | {
      action: 'send';
      items: Item[];
      caption: string;
      format: Format;
      // Explicit header title (`--title`). Appears on the `✳️ [window]` line as
      // `✳️ [window] <title>`. The message body is NEVER pulled up here.
      title?: string;
      // Explicit message tag (`--tag`). Rendered as a wordmark pill (custom-emoji
      // cells + readable word): `✳️ [window] 🔵 ANSWER`. Composes with `--title`.
      tag?: string;
      // Explicit subagent/sender label (`--agent <name>`). Appears as its own
      // `[agent]` bracket right after `[window]`: `✳️ [window] [agent] <title>`.
      // Wins over the entrypoint's env-based auto-detection (see
      // `features/agent-detect/detect.ts`) — an orchestrator dispatching many
      // subagents should pass a descriptive name here (e.g. `--agent
      // hyperide-fixer`) since metadata-based auto-detection is best-effort
      // and may fall back to "some subagent".
      agent?: string;
      // code-as-pdf: also attach the raw original file alongside the rendered
      // PDF (`--with-original`). Default is PDF-only for code/config files.
      withOriginal?: boolean;
      // code-as-pdf: skip the PDF render entirely and attach the original file
      // (`--no-pdf`) — today's behavior. Wins over --with-original.
      noPdf?: boolean;
      // code-as-pdf: device preset for the mobile PDF page geometry
      // (`--pdf-device <name>`, e.g. iphone15pro / a4). Overrides TG_PDF_DEVICE.
      pdfDevice?: string;
      // Threaded reply (`--reply-to <message_id>`): sets reply_to_message_id on
      // the outbound sendMessage so it threads UNDER that inbound Telegram
      // message. The id is Telegram's own per-chat sequential message_id (the
      // daemon surfaces it in the injected wrap as `#<id>`). Absent when the flag
      // is not given (keeps no-flag send results byte-identical).
      replyTo?: number;
      // Forum topic (`--topic <id>`): sets message_thread_id on EVERY outbound
      // send so an agent's `tg` reply threads INTO its bound topic instead of
      // General (docs/specs/tg-forum-topics.md §8). The id is the topic's
      // message_thread_id. The entrypoint falls back to the TG_TOPIC env when the
      // flag is absent; an explicit flag wins. Absent (and no TG_TOPIC) keeps
      // no-flag send results byte-identical for the 1:1 path.
      topic?: number;
      // `tg --table`: read delimited rows from stdin, render an aligned <pre>
      // monospace table, and send it (composes with --tag/--title). The flag is
      // a boolean; the rows come from stdin, not argv. Absent when not given.
      table?: true;
      // `--terminal-question`: the HIDDEN escape for the `answer`-requires-
      // `--reply-to` gate. The answered question originated in the TERMINAL (the
      // Claude/agent harness) where there is no inbound Telegram message_id to
      // reply to, so an `--tag answer` legitimately has no `--reply-to` target.
      // This flag — and ONLY this flag — permits that. It is DELIBERATELY absent
      // from USAGE/`--help`: the only place it is surfaced is the error raised
      // when `--tag answer` lacks `--reply-to`. Absent when not given, so a
      // normal send result stays byte-identical.
      terminalQuestion?: true;
      // Tier-1 escalation-format ADVISORY (WARN-mode default): set when a
      // `--tag decision|question` send carries no literal table. parseArgs
      // does NOT block on it — it attaches the copy-pasteable guidance here and
      // still returns a `send`. The entrypoint prints it to stderr and, ONLY
      // when the off-by-default `ESCALATION_GATE_ENFORCE` flag is set
      // (escalationGateEnforced), upgrades it to a hard stop (exit 1). This is
      // the skill-first → warn → later-flip-to-block rollout: nothing hard-
      // blocks a decision/question send today. Absent (undefined) on every
      // other send, so those results stay byte-identical.
      escalationWarning?: string;
    };

// Extensions that Telegram's sendPhoto accepts. SVG is intentionally excluded:
// Telegram rejects SVG as a photo, so an auto-detected .svg path falls back to
// a document (explicit --photo still honors the user's choice).
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif']);

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// A "real" extension = a dot at basename position >0 with word chars after it.
// LICENSE, Makefile, tg → none; .env (dot at 0, nothing more) → none either.
// The auto-attach scanner skips extensionless files: they are usually
// code-adjacent artifacts the receiver can't preview, and dotfiles tend to
// hold secrets. Explicit --photo/--file remain a direct instruction.
export function hasRealExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /^.+\.[A-Za-z0-9]+$/.test(base);
}

export function expandHome(token: string, home: string): string {
  if (token === '~') return home;
  if (token.startsWith('~/')) return join(home, token.slice(2));
  return token;
}

/**
 * Resolve a text token to an existing file path, if it is one.
 * Tries ~-expansion, absolute, and cwd-relative resolution.
 * Returns the absolute path only when it resolves to a real file (not a dir).
 */
export function resolveExistingFile(token: string, cwd: string, home: string): string | null {
  if (!token) return null;
  const expanded = expandHome(token, home);
  const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch {
    // not a path / no access — treat as ordinary text
  }
  return null;
}

// --- TAG_GATES: per-tag parse-time checks (Tier 1 of the escalation-format
// gate; see docs/specs escalation-format design). Each gate inspects the
// already-parsed fields and returns a result with a SEVERITY, or null to let
// it through. Kept as a registry (not a hardcoded `if` per tag) so a future
// gated tag is one entry, not another branch to thread through.
//
// SEVERITY decides what parseArgs does with a non-null result:
//   'block'    → hard `action: 'error'` (exit 1). Used for the `answer`-gate:
//                a `--tag answer` with no reply target is genuinely malformed.
//   'advisory' → attached as `escalationWarning` on a still-successful `send`.
//                parseArgs NEVER blocks on it. Used for the decision/question
//                escalation-format check: it is WARN-mode by default (the
//                skill-first → warn → later-flip-to-block rollout). The
//                entrypoint prints the guidance and only upgrades it to a hard
//                stop when the off-by-default ESCALATION_GATE_ENFORCE flag is
//                set (see escalationGateEnforced below).
interface TagGateContext {
  // The canonical lowercase tag that selected this gate (e.g. "decision",
  // "question") — so a shared gate (escalationTableGate serves BOTH) can
  // still report the ACTUAL tag the caller used, not a hardcoded list that
  // silently goes stale the moment a third escalation tag is added.
  tag: string;
  caption: string;
  table?: true;
  replyTo?: number;
  terminalQuestion?: true;
}
interface TagGateResult {
  message: string;
  severity: 'block' | 'advisory';
}
type TagGate = (ctx: TagGateContext) => TagGateResult | null;

// Is the escalation-format Tier-1 gate in ENFORCE (hard-block) mode? OFF by
// default — a missing table on a decision/question send is advisory (warn +
// proceed). Set ESCALATION_GATE_ENFORCE=1 (or true/yes/on) to make it exit 1
// instead. The later "flip to block" PR just changes this default once the tg
// skill documents the table requirement and a warn period has passed.
// Same trim+lowercase truthy parse as the AGENTS_HOOKS_TRUST guard.
export function escalationGateEnforced(env: NodeJS.ProcessEnv): boolean {
  const v = (env.ESCALATION_GATE_ENFORCE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// The `answer` tag means "I am answering THIS specific message", so it
// requires a reply target. Without `--reply-to` a `--tag answer` has no thread
// to attach to and reads as a reply that isn't one — make it an actionable
// error.
//
// The ONE legitimate exception: the question originated in the TERMINAL (the
// Claude/agent harness) where no inbound Telegram message_id exists to reply
// to. `--terminal-question` is the explicit, HIDDEN escape for exactly that
// case — it permits `--tag answer` without `--reply-to`. The flag is NOT in
// USAGE/--help by design; the only place it is surfaced is this very error
// message, and only framed as the terminal-origin escape. So a normal user
// reading --help never sees it; only someone who hit THIS error and genuinely
// has a terminal-origin question (no Telegram id) learns it.
const answerGate: TagGate = ({ replyTo, terminalQuestion }) => {
  if (replyTo !== undefined || terminalQuestion) return null;
  return {
    severity: 'block',
    message:
      '--tag answer must reply to a specific message — pass --reply-to <message_id>. ' +
      'Use the id from the inbound `[TG from … #<id>]` wrap. ' +
      'If this answers a question that originated in the terminal and there is no ' +
      'Telegram message id to reply to, pass --terminal-question.',
  };
};

// `decision` / `question` are ESCALATION tags — they ask the recipient to
// choose or decide, and the standard escalation form for that is a literal
// table (options / tradeoffs / recommendation), not a prose paragraph the
// recipient has to re-derive. This is the CHEAP, obvious-case-only half of
// the gate: it only catches a message that has NO table-ish content anywhere
// (no <table>, no boxed --table output, no markdown pipe rows). A subtler
// case (e.g. a table that doesn't actually answer the question) is left to
// the advisory pre-send-text hook
// (features/hooks/escalation-format-descriptor/pre_send_text_gate.ts),
// which runs later and sees the FINAL body.
//
// SEVERITY IS 'advisory' — WARN-mode by default. This gate NEVER hard-blocks a
// send on its own; parseArgs attaches its message as `escalationWarning` and
// still returns a `send`. Only the entrypoint, and only under the off-by-
// default ESCALATION_GATE_ENFORCE flag, upgrades it to exit 1. (Rollout: ship
// the tg skill documenting the table requirement, run a warn period, THEN flip
// the enforce default. Blocking on day one — before the skill even documents
// it — would hard-break every existing decision/question send.)
//
// `--table` reads its rows from STDIN, which parseArgs never sees (the
// entrypoint reads stdin after parsing) — a `--table` send WILL carry a
// rendered table by construction, so this gate is a no-op for it.
//
// TODO(escalation-gate bypass): a future RIG_HATCH_REQUEST-style override is
// meant to let a genuinely urgent send through this gate (once enforced)
// without a table, pending live approval (see the design's "bypass may wait
// up to 15 min for live approval" note). Not wired here yet — this is the hook
// point for it: check the bypass signal FIRST and `return null` when present.
const escalationTableGate: TagGate = ({ tag, caption, table }) => {
  if (table) return null;
  if (detectTableKind(caption) !== 'none') return null;
  // The message is the CORE guidance only (what to do). The mode-specific
  // framing — "advisory, sending anyway" vs "blocked" — is appended by the
  // ENTRYPOINT, which is the only place that knows whether ESCALATION_GATE_
  // ENFORCE is set. Baking a fixed "the send is proceeding / set the flag"
  // tail here would contradict the enforce-mode output (send blocked, flag
  // already set) — review finding.
  return {
    severity: 'advisory',
    message:
      `--tag ${tag} sends work best as a literal table (the escalation form) ` +
      `so the recipient can answer without re-deriving the question. Fill one in and resend, ` +
      `e.g.:\n` +
      `| Option | Tradeoff | Recommendation |\n` +
      `| --- | --- | --- |\n` +
      `| A | ... | ... |\n` +
      `| B | ... | ... |\n` +
      `(Or send it as \`tg --table\`, or an HTML <table> with --format html.)`,
  };
};

const TAG_GATES: Record<string, TagGate> = {
  answer: answerGate,
  // Every ESCALATION_TAGS entry gets the same gate — built from the shared
  // list (features/render/tag.ts) instead of two hardcoded keys, so it can't
  // drift from the hook's own GATED_TAGS set.
  ...Object.fromEntries(ESCALATION_TAGS.map((t) => [t, escalationTableGate])),
};

/**
 * Parse argv (already sliced past node/script) into an action. Never throws and
 * never calls process.exit: the caller decides what to do with the result.
 *
 * Precedence (the reconciliation point for "unknown dashed → error"):
 *   1. -h/--help and -v/--version win anywhere, before everything else.
 *   2. Info-only flags --ls-emoji-helpers / --detect-model / --detect-agent win next.
 *   3. Real flags are matched: --format (with value validation), --photo,
 *      --file (each consuming a path value).
 *   4. ONLY a dashed token that matched none of the above is "unknown" → error.
 * This guarantees every flag main supports is recognized before the
 * unknown-dashed guard can fire, so none of them regress to an error.
 */
export function parseArgs(
  args: string[],
  cwd: string,
  home: string,
  autoAttach = true,
  // Worktree-aware fallback: a memoized thunk returning the priority-ordered
  // list of git worktree roots to probe when a path-like token fails plain
  // cwd/~/absolute resolution. Injected so tests stub it (and `main` memoizes
  // the real `enumerateWorktreeRoots`). Defaults to "no extra roots" — with the
  // thunk absent, resolution is exactly the old cwd-only behavior.
  getWorktreeRoots: () => string[] = () => [],
  // Never-attach denylist (feature `attach-denylist`, ON by default): secret-
  // looking files (.env family, private keys, credential rc-files, …) are
  // silently skipped by the auto-scan and a HARD ERROR for explicit flags.
  attachDenylist = true,
  // Recursive resolution (feature `recursive-attach`, ON by default): third
  // fallback after plain and worktree-root joins — search the worktree roots
  // (or cwd outside a git repo) recursively for the mentioned file (auto-attach
  // spec §Recursive resolution). The index thunk is injectable for tests;
  // the default builds one lazy real-fs index per parseArgs call.
  recursiveAttach = true,
  getFileIndex?: () => string[],
  // Message-reference autolinking (feature `autolink-msgrefs`, ON by default): gates the
  // `--title` tg#<id> guard below, mirroring the SAME flag the body-detection call in the `tg`
  // entrypoint already gates on. With the feature off, a `tg#<id>` is inert plain text (no
  // linkify, no gate) in BOTH the title and the body — consistent, rather than banning it from
  // the title while the identical literal is freely allowed in the body (task-cli#45 / tg-cli
  // review finding on PR #139).
  msgrefAutolink = true,
): ParseResult {
  // 1. Help / version win anywhere, before the empty check.
  for (const a of args) {
    if (a === '-h' || a === '--help') return { action: 'help' };
  }
  for (const a of args) {
    if (a === '-v' || a === '--version') return { action: 'version' };
  }

  // 2. Info-only flags win next, anywhere on the line.
  for (const a of args) {
    if (a === '--ls-emoji-helpers') return { action: 'lsEmojiHelpers' };
  }
  for (const a of args) {
    if (a === '--detect-model') return { action: 'detectModel' };
  }
  for (const a of args) {
    if (a === '--detect-agent') return { action: 'detectAgent' };
  }
  for (const a of args) {
    if (a === '--format-help') return { action: 'formatHelp' };
  }

  const explicit: Item[] = [];
  const textParts: string[] = [];
  let format: Format = 'plain';
  let title: string | undefined;
  let tag: string | undefined;
  let agent: string | undefined;
  // Left undefined when the flag is absent so a no-flag parse result stays
  // byte-identical to before (the test suite asserts the send object with
  // toEqual and omits unset optional fields — same convention as title/tag).
  let withOriginal: true | undefined;
  let noPdf: true | undefined;
  let pdfDevice: string | undefined;
  let replyTo: number | undefined;
  let topic: number | undefined;
  let table: true | undefined;
  // Hidden escape for the answer-gate (see the gate below + the type comment on
  // `terminalQuestion`). Never advertised in USAGE/--help.
  let terminalQuestion: true | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--format') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--format requires plain or html' };
      }
      if (nextArg !== 'plain' && nextArg !== 'html') {
        return {
          action: 'error',
          message: `unsupported format '${nextArg}'. Accepted values: plain, html`,
        };
      }
      format = nextArg;
      i += 2;
      continue;
    }
    if (arg === '--title') {
      const nextArg = args[i + 1];
      // Require a value; a dashed next token is treated as a missing value
      // (consistent with --format), so `--title --tag X` errors rather than
      // silently swallowing the next flag as the title.
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--title requires a value' };
      }
      // A `tg#<id>` message reference in the header line defeats its own
      // purpose: --title is a one-line header (`✳️ [window] <title>`), not a
      // place a reader can follow a reference from — and unlike the message
      // body, nothing here ever gets linkified. Refuse instrumentally (the
      // same rule task-cli/gh-ship enforce on a ticket/PR title) rather than
      // silently sending an inert `tg#1234` in the header. Gated on the SAME
      // `autolink-msgrefs` feature flag the body detection uses (`tg`'s main
      // entrypoint) — with the feature off, `tg#<id>` is inert plain text
      // everywhere, in the title exactly like the body, not banned in one and
      // freely allowed in the other.
      if (msgrefAutolink && detectMsgRefs(nextArg).length > 0) {
        return {
          action: 'error',
          message: 'Refusing: --title contains a tg#<id> reference — move it into the message body.',
        };
      }
      title = nextArg;
      i += 2;
      continue;
    }
    if (arg === '--tag') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--tag requires a value' };
      }
      // Reject anything that is not a lowercase-english tag (uppercase,
      // Cyrillic, unknown) right here, with a 3-part WHAT/WHY/HOW message and a
      // non-zero exit (the caller maps `action: 'error'` → exit 1). See the
      // INPUT POLICY in features/render/tag.ts.
      const tagError = validateTag(nextArg);
      if (tagError) {
        return { action: 'error', message: tagError };
      }
      // Store the trimmed canonical form. validateTag accepts surrounding
      // whitespace (`' answer '`), so normalize here — otherwise the literal
      // `tag === 'answer'` answer-gate below (and the value handed to send)
      // would carry the padding and the gate would miss a padded `answer`.
      tag = nextArg.trim();
      i += 2;
      continue;
    }
    // Explicit subagent/sender label: `--agent <name>`. Same "require a value,
    // a `--`-prefixed next token is a missing value" contract as --title/--tag
    // (a single-dash token like `-x` IS accepted as a literal value, same
    // parity as those flags) — so `--agent --tag X` errors rather than
    // swallowing `--tag` as the label. No content restriction (unlike --tag's
    // lowercase-english set): the label is a free-form identifier an
    // orchestrator picks per dispatch — it reaches Telegram HTML-escaped via
    // styleWindowName (features/prefix-style/style.ts), same as `[window]`. A
    // whitespace-only value (`--agent "   "`) is REJECTED the same as a
    // missing one (review finding, tg#6254) — trimming it silently to '' would
    // otherwise fall through to env/auto-detection below, breaking the
    // documented "explicit flag always wins" invariant for what looks like an
    // explicit choice.
    if (arg === '--agent') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--') || !nextArg.trim()) {
        return { action: 'error', message: '--agent requires a value' };
      }
      agent = nextArg.trim();
      i += 2;
      continue;
    }
    // code-as-pdf flags. `--with-original` and `--no-pdf` are booleans; consume
    // only themselves. `--pdf-device` consumes a value.
    if (arg === '--with-original') {
      withOriginal = true;
      i += 1;
      continue;
    }
    if (arg === '--no-pdf') {
      noPdf = true;
      i += 1;
      continue;
    }
    if (arg === '--pdf-device') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--pdf-device requires a value' };
      }
      pdfDevice = nextArg;
      i += 2;
      continue;
    }
    // Threaded reply: `--reply-to <message_id>`. The value must be a positive
    // integer (Telegram's own per-chat message_id); anything else is a clear
    // error rather than a silently-dropped reply.
    if (arg === '--reply-to') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--reply-to requires a message id' };
      }
      if (!/^[1-9][0-9]*$/.test(nextArg)) {
        return {
          action: 'error',
          message: `--reply-to expects a positive message id, got '${nextArg}'`,
        };
      }
      replyTo = Number(nextArg);
      i += 2;
      continue;
    }
    // Forum topic: `--topic <id>`. Same validation as --reply-to (a positive
    // integer message_thread_id); anything else is a clear error rather than a
    // silently-dropped topic (which would scatter the reply to General).
    if (arg === '--topic') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--topic requires a topic id' };
      }
      if (!/^[1-9][0-9]*$/.test(nextArg)) {
        return {
          action: 'error',
          message: `--topic expects a positive topic id, got '${nextArg}'`,
        };
      }
      topic = Number(nextArg);
      i += 2;
      continue;
    }
    // `--table` is a boolean — the rows are read from stdin by the entrypoint.
    if (arg === '--table') {
      table = true;
      i += 1;
      continue;
    }
    // `--terminal-question` is a boolean — the HIDDEN escape for the
    // `answer`-requires-`--reply-to` gate (see the gate below). Recognized here
    // so it is consumed as a real flag (not an "unknown flag" error and not
    // swallowed into the message text), but it is intentionally NOT documented
    // in USAGE/--help: it must only be learned from the gate's error message.
    if (arg === '--terminal-question') {
      terminalQuestion = true;
      i += 1;
      continue;
    }
    if (arg === '--photo' || arg === '--file') {
      const nextArg = args[i + 1];
      // A dashed next token is only consumed as a path when it actually
      // resolves to an existing file (e.g. `--file -receipt.png`). Otherwise
      // it is a missing/invalid path → error, matching main's behavior.
      const dashedButNotAFile =
        !!nextArg && nextArg.startsWith('-') && resolveExistingFile(nextArg, cwd, home) === null;
      if (!nextArg || dashedButNotAFile) {
        return { action: 'error', message: `${arg} requires a file path argument` };
      }
      if (attachDenylist && isNeverAttach(nextArg)) {
        return {
          action: 'error',
          message:
            `refusing to attach '${nextArg}': matches the never-attach denylist (secrets). ` +
            'Override with --no-feature attach-denylist',
        };
      }
      explicit.push({ type: arg === '--photo' ? 'photo' : 'document', path: nextArg });
      i += 2;
      continue;
    }
    // A standalone dashed token that matched no known flag (and is not a flag
    // value, since those are consumed above) is an unknown flag → error.
    if (arg.startsWith('-')) {
      return { action: 'error', message: `unknown flag: ${arg}` };
    }
    // Anything else is plain text.
    textParts.push(arg);
    i += 1;
  }

  // Auto-detect existing-file paths in the message text. Split the joined text
  // on whitespace so both `tg /tmp/x.png` and `tg "look /tmp/x.png"` work.
  const explicitResolved = new Set(
    explicit.map((it) => resolveExistingFile(it.path, cwd, home)).filter((p): p is string => p !== null),
  );
  const autoItems: Item[] = [];
  // CORE CORRECTION (spec §"never excise a path"): a path mentioned in the text
  // STAYS in the text verbatim. We only DETECT it and attach the file — we never
  // strip the token from the caption. (The old behavior excised it; that is now
  // reversed.) Tokenize purely to find file references; the caption is the
  // original joined text, untouched except for outer-edge trimming.
  //
  // Auto-detection is the `auto-attach` FEATURE. When it is OFF, we skip the
  // scan entirely — only explicit --photo/--file are attached, and any path in
  // the text stays as plain words (it is never attached).
  if (autoAttach) {
    // Worktree-aware resolution (CTO request): when a token fails the plain
    // cwd/~/absolute resolve, AND it looks path-like, fall back to probing the
    // git worktree roots in priority order (current → main → branch-matched →
    // rest). `getWorktreeRoots` is the injected, memoized thunk; the path-like
    // gate keeps git OUT of the hot path for ordinary prose. This only changes
    // WHERE a relative path resolves — never the R1–R4 attach rules.
    const fileExistsAbs = (p: string): boolean => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    };
    // Recursive index (feature `recursive-attach`): built lazily, at most once
    // per parseArgs call, and ONLY when some token actually reaches the third
    // fallback — ordinary sends never pay for a tree walk.
    const realListDir: ListDir = (abs) => {
      try {
        return readdirSync(abs, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isFile: d.isFile(),
          isDirectory: d.isDirectory(),
        }));
      } catch {
        return null;
      }
    };
    let fileIndexCache: string[] | null = null;
    const getIndex =
      getFileIndex ??
      ((): string[] => {
        if (fileIndexCache === null) {
          const roots = getWorktreeRoots();
          fileIndexCache = buildFileIndex(roots.length > 0 ? roots : [cwd], realListDir);
        }
        return fileIndexCache;
      });
    const resolveWithWorktrees = (token: string): string | null => {
      const plain = resolveExistingFile(token, cwd, home);
      if (plain) return plain;
      if (!looksPathLike(token)) return null;
      const roots = getWorktreeRoots();
      if (roots.length > 0) {
        const fromWorktrees = resolveAcrossWorktrees(token, roots, fileExistsAbs);
        if (fromWorktrees) return fromWorktrees;
      }
      // Third fallback: recursive search (auto-attach spec §Recursive
      // resolution). The hit is re-checked against the real fs — the index
      // may be stale within a long-running process.
      if (recursiveAttach && isRecursiveCandidate(token)) {
        const hit = matchFromIndex(token, getIndex());
        if (hit && fileExistsAbs(hit)) return hit;
      }
      return null;
    };
    const segments = textParts.join(' ').split(/(\s+)/);
    for (let s = 0; s < segments.length; s++) {
      const isWhitespace = s % 2 === 1;
      const seg = segments[s];
      if (isWhitespace || !seg) continue;
      // First try a plain existing-file resolve. If that fails, the token may
      // carry a trailing line-spec (file.ts:42 / :42-50 / :42:5) — strip it and
      // resolve the base path. The full token stays in the caption either way.
      // Both resolves go through the worktree-aware fallback.
      let resolved = resolveWithWorktrees(seg);
      let spec: ItemLineSpec | undefined;
      if (!resolved) {
        // Try the raw token, then the same token with wrapping punctuation stripped
        // (`(file.ts:42)`, `file.ts:42.`, `` `file.ts:42` ``) so a spec glued to prose
        // punctuation still resolves (tg#29). The full original `seg` stays the caption token.
        const ls = parseLineSpec(seg) ?? parseLineSpec(stripSpecWrappers(seg));
        if (ls) {
          const baseResolved = resolveWithWorktrees(ls.path);
          if (baseResolved) {
            resolved = baseResolved;
            spec = {
              token: seg,
              startLine: ls.startLine,
              endLine: ls.endLine,
              col: ls.col,
            };
          }
        }
      }
      if (!resolved) continue;
      // Extensionless gate: an auto-DETECTED file without a real extension is
      // never attached (the token stays in the text as plain words).
      if (!hasRealExtension(resolved)) continue;
      // Never-attach denylist: a secret-looking file mentioned in the text is
      // never attached (the token stays as plain words).
      if (attachDenylist && isNeverAttach(resolved)) continue;
      if (explicitResolved.has(resolved)) {
        // Already attached (explicit --file/--photo or an earlier mention). Don't
        // attach twice, but if THIS mention carried a line-spec and the existing
        // item has none, adopt it so `--file x.ts "see x.ts:42"` still renders a
        // quote. First spec per file wins (a second, different spec is ignored —
        // documented in docs/specs/auto-attach.md; the marker copy can only mark
        // one range). Match on the resolved path, not the raw arg string.
        if (spec) {
          // Re-resolve via the SAME worktree-aware path so a cross-worktree
          // file (whose plain resolve is null) still matches its existing item.
          const existing = [...explicit, ...autoItems].find(
            (it) => resolveWithWorktrees(it.path) === resolved && !it.lineSpec,
          );
          if (existing) existing.lineSpec = spec;
        }
        continue;
      }
      explicitResolved.add(resolved); // dedup repeats within the text too
      const item: Item = { type: isImagePath(resolved) ? 'photo' : 'document', path: resolved, auto: true };
      if (spec) item.lineSpec = spec;
      autoItems.push(item);
    }
  }

  const items = [...explicit, ...autoItems];
  // Trim only the outer edges; interior formatting (newlines, alignment) stays.
  // The path token is intentionally KEPT in the caption (core correction).
  const caption = textParts.join(' ').replace(/^\s+|\s+$/g, '');

  // Per-tag parse-time gates (TAG_GATES above) — a cheap, in-process check run
  // before anything else (no subprocess, no hook). `tag` was already validated
  // to one of the lowercase-english words, so a plain registry lookup suffices.
  // A 'block' result (answer-gate) hard-errors here; an 'advisory' result
  // (escalation-format) is attached as escalationWarning and the send still
  // proceeds — the entrypoint decides warn-vs-block via ESCALATION_GATE_ENFORCE.
  let escalationWarning: string | undefined;
  if (tag !== undefined) {
    const gate = TAG_GATES[tag];
    if (gate) {
      const result = gate({ tag, caption, table, replyTo, terminalQuestion });
      if (result) {
        if (result.severity === 'block') return { action: 'error', message: result.message };
        escalationWarning = result.message;
      }
    }
  }

  // Empty invocation (or nothing left after path excision) → help, exit 0.
  // A bare `--title`/`--tag`/`--table`/`--reply-to` still sends (a header-only
  // or table or reply message), so none of those is an empty invocation. The
  // `--table` body arrives on stdin, read by the entrypoint after parsing.
  if (items.length === 0 && !caption && !title && !tag && !agent && !table && replyTo === undefined) {
    return { action: 'help' };
  }
  return {
    action: 'send',
    items,
    caption,
    format,
    title,
    tag,
    agent,
    withOriginal,
    noPdf,
    pdfDevice,
    replyTo,
    topic,
    table,
    terminalQuestion,
    escalationWarning,
  };
}

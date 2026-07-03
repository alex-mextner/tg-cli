// Inbound → ticket-triage hook for tg-ctl (task-cli spec §8). PURE — the tg-ctl
// daemon passes the raw getUpdates batch + config; this decides WHICH messages
// look like a request worth classifying and builds the `task classify` argv. The
// daemon owns the spawn (best-effort, OFF the inject path) and parses the result
// back through parseClassifyResult.
//
// Why a separate module, mirroring features/replies/inbound.ts: the selection
// logic (sender allowlist + staleness + "is this a request") and the result
// parsing are pure and unit-testable, while the entrypoint keeps the single
// effectful spawn. Classification NEVER blocks the agent seeing the message
// (spec §8): the daemon injects first, then fires this in the background.
//
// OPT-IN: the daemon only walks this when `control.classify: true`. Disabled by
// default — it costs a classifier call per message and needs the `task` CLI on
// PATH. A missing `task` or a classify error is swallowed by the daemon's
// spawnGuarded (exit 127 / non-zero) and never crashes the poll loop.

import type { TgMessage, TgUpdate } from './types';

export interface ClassifyOpts {
  chatId: number; // the owner chat id (always allowed)
  allowedSenders: number[]; // extra allowed sender user ids (cfg.allowedSenders)
  // Staleness drop, mirroring stepUpdates so triage == what the daemon actually
  // processed. Omit both to classify every allowed request regardless of age.
  nowSec?: number;
  stalenessSec?: number;
}

// A message worth classifying: the prose the CTO actually sent. message_id is
// carried so the daemon can thread the ticket report back under the request.
export interface ClassifiableMessage {
  messageId: number;
  text: string;
}

function senderAllowed(sender: number | undefined, opts: ClassifyOpts): boolean {
  return sender !== undefined && (sender === opts.chatId || opts.allowedSenders.includes(sender));
}

// A message "looks like a request" (spec §8) when it carries plain prose — NOT a
// /command (those are control verbs: /stop, /status, /agent, … and harness
// passthroughs like /compact), and NOT media-only. A photo/document caption is
// still prose the user typed, so it counts; a bare media item with no caption
// does not. The classifier (task-cli) makes the final change-vs-justAsk call —
// this filter only screens out the obviously-non-request kinds so we never spend
// a classifier call on a `/status` tap or a sticker.
function requestText(m: TgMessage): string | null {
  const prose = m.text ?? m.caption;
  if (!prose) return null; // media-only / sticker / non-text → not a request
  const trimmed = prose.trim();
  if (!trimmed) return null; // whitespace-only
  if (trimmed.startsWith('/')) return null; // a slash-command is a control verb, not a ticket
  return trimmed;
}

// Walk a getUpdates batch and return the inbound prose requests to classify,
// applying the SAME sender-allowlist + staleness gates stepUpdates uses so triage
// matches what the daemon actually delivered to the agent. Replies are included:
// a reply carrying prose is still a request the user made.
export function classifiableMessages(updates: TgUpdate[], opts: ClassifyOpts): ClassifiableMessage[] {
  const out: ClassifiableMessage[] = [];
  for (const u of updates) {
    const m = u.message;
    if (!m) continue; // callback queries + non-message updates are not requests
    if (!senderAllowed(m.from?.id, opts)) continue; // a group member is never classified
    if (
      opts.nowSec !== undefined &&
      opts.stalenessSec !== undefined &&
      opts.nowSec - m.date > opts.stalenessSec
    ) {
      continue; // mirror stepUpdates' staleness drop
    }
    const text = requestText(m);
    if (text === null) continue;
    out.push({ messageId: m.message_id, text });
  }
  return out;
}

// The classify shell-out (spec §8): `task classify "<text>" --create`. `-C <cwd>`
// pins task-cli to the agent's project (its `task` config + session live there);
// the daemon passes the discovered agent pane's cwd, falling back to its own.
// Returned as argv (no shell) so the message text is never interpolated into a
// command line — special chars in the user's prose are passed verbatim.
export function buildClassifyArgv(text: string, cwd: string): string[] {
  return ['task', '-C', cwd, 'classify', text, '--create'];
}

// What `task classify --create` did, parsed from its stdout. The first non-warn
// line is the verdict (`change` | `justAsk`); on a `change`+`--create` run a
// follow-up line names the ticket (`created <id> …` | `appended to <id> …`).
export interface ClassifyResult {
  verdict: 'change' | 'justAsk' | null; // null when stdout had no recognizable verdict
  ticketId: string | null; // the created/deduped ticket id, when one was touched
  action: 'created' | 'appended' | null; // which mutation happened
}

// ANSI escape sequences (task-cli colorizes only on a TTY, which a piped spawn is
// not — but strip defensively so a colorized stdout still parses).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Parse task-cli's stdout. The output contract (tasklib/cli.py cmd_classify):
//   line 1: the verdict — `change` or `justAsk`
//   on `change`+`--create`: `created <id> from message  <url>`
//                        or `appended to <id> (dedup)`
// A `--json` verdict line (`{"verdict":"change"}`) is also tolerated. Anything
// unrecognized → nulls (the daemon reports "triaged" with no id, never crashes).
export function parseClassifyResult(stdout: string): ClassifyResult {
  const lines = stdout
    .replace(ANSI_RE, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let verdict: ClassifyResult['verdict'] = null;
  let ticketId: string | null = null;
  let action: ClassifyResult['action'] = null;

  for (const line of lines) {
    if (verdict === null) {
      const jsonMatch = line.match(/"verdict"\s*:\s*"(change|justAsk)"/);
      if (jsonMatch) verdict = jsonMatch[1] as ClassifyResult['verdict'];
      else if (line === 'change' || line === 'justAsk') verdict = line;
    }
    const created = line.match(/^created\s+(\S+)/);
    if (created) {
      action = 'created';
      ticketId = created[1];
      continue;
    }
    const appended = line.match(/^appended to\s+(\S+)/);
    if (appended) {
      action = 'appended';
      ticketId = appended[1];
    }
  }

  return { verdict, ticketId, action };
}

// The one-line TG report for a classify run, or null when there is nothing worth
// telling the CTO (a `justAsk` verdict that created no ticket — silence is the
// right outcome there, the message already reached the agent). A `change` with no
// recognizable ticket id still reports "triaged" so a backend hiccup is visible.
export function formatClassifyReport(result: ClassifyResult): string | null {
  if (result.ticketId) {
    const verb = result.action === 'appended' ? 'updated' : 'created';
    return `🎫 ${verb} ${result.ticketId}`;
  }
  if (result.verdict === 'change') return '🎫 triaged (no ticket id returned)';
  return null; // justAsk / unrecognized → no ticket, no noise
}

// Update→action step function for the tg-ctl daemon (spec §9, §10, §13).
//
// stepUpdates turns one getUpdates batch into a list of Actions plus the next
// offset. Everything here is PURE — the entrypoint executes the actions and
// owns all I/O. The wrap template function is injected via opts so this module
// never imports inject.ts (the entrypoint binds wrapInbound to the config
// template).
//
// Delivery semantics are at-most-once (spec §10): the offset advances over
// EVERY update — rejected senders, stale messages and unsupported kinds
// included — so nothing is ever replayed into a live agent session.

import type { Action, ControlConfig, StepResult, TgMessage, TgUpdate } from './types';
import { parseButtonCallback } from './questions';
import { parseAgentCallback, parseAgentCommand } from './agent-match';

// Bot API getFile hard limit; larger files cannot be downloaded by bots.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const TOO_LARGE_REPLY = 'file too large for Bot API (>20 MB)';

export interface StepOpts {
  cfg: ControlConfig;
  chatId: number;
  nowSec: number;
  currentOffset: number; // returned as newOffset when the batch is empty
  wrap: (name: string, msg: string) => string;
  // Format a reply's quote-anchor timestamp (item 3). Injected so the daemon
  // can use local time while tests stay deterministic; defaults to UTC.
  fmtTime?: (unixSec: number) => string;
}

// Default quote-anchor time format: deterministic UTC `YYYY-MM-DD HH:MM`.
function fmtQuoteTimeUtc(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// First chars of the quote-anchor body, separators collapsed, with a trailing
// ellipsis (item 3: «… начало сообщения и многоточие …»).
const QUOTE_HEAD_MAX = 60;

// Build the injected text for a REPLY (items 2, 3). The agent sees which message
// is being answered — `↩ «[date time] <quote>…»` — followed by the wrapped reply.
// The quoted content is the user's PARTIAL selection when present (item 2),
// otherwise the beginning of the replied-to message (item 3).
export function buildReplyInject(m: TgMessage, name: string, opts: StepOpts): string {
  const rtm = m.reply_to_message;
  const original = ((rtm?.text ?? rtm?.caption) ?? '').replace(/\s+/g, ' ').trim();
  const selected = m.quote?.text?.replace(/\s+/g, ' ').trim();
  const body = selected || original;
  const head = body.length > QUOTE_HEAD_MAX ? `${body.slice(0, QUOTE_HEAD_MAX)}…` : `${body}…`;
  const when = rtm ? (opts.fmtTime ?? fmtQuoteTimeUtc)(rtm.date) : '';
  const anchor = `↩ «[${when}] ${head}»`;
  return `${anchor}\n${opts.wrap(name, m.text ?? '')}`;
}

export function stepUpdates(updates: TgUpdate[], opts: StepOpts): StepResult {
  const callbackActions: Action[] = [];
  const actions: Action[] = [];
  let skippedStale = 0;
  let maxId = -1;

  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const cb = u.callback_query;
    if (cb) {
      if (!senderAllowed(cb.from?.id, opts)) {
        callbackActions.push({ kind: 'answer-callback', callbackQueryId: cb.id, text: 'not allowed' });
        continue;
      }
      // /agent selection taps (tga:…) route first; q→buttons taps (tgq:…) next.
      const agentCb = parseAgentCallback(cb.data);
      if (agentCb) {
        callbackActions.push({
          kind: 'agent-callback',
          callbackQueryId: cb.id,
          token: agentCb.token,
          index: agentCb.index,
          from: cb.from?.first_name || cb.from?.username || 'tg',
          messageId: cb.message?.message_id ?? null,
        });
        continue;
      }
      const parsed = parseButtonCallback(cb.data);
      callbackActions.push(
        parsed
          ? {
              kind: 'answer-question',
              callbackQueryId: cb.id,
              requestId: parsed.requestId,
              value: parsed.value,
              messageId: cb.message?.message_id ?? null,
            }
          : { kind: 'answer-callback', callbackQueryId: cb.id, text: 'expired' },
      );
      continue;
    }

    const m = u.message;
    if (!m) continue; // non-message/callback update → advance silently

    // Sender allowlist FIRST (spec §9: from.id, not chat id — a group member
    // must not inject prompts). Rejected senders also never inflate the stale
    // count, so the "skipped N stale" notice only reports the owner's backlog.
    if (!senderAllowed(m.from?.id, opts)) continue;

    if (opts.nowSec - m.date > opts.cfg.stalenessSec) {
      skippedStale += 1;
      continue;
    }

    const name = m.from?.first_name || m.from?.username || 'tg';
    let action: Action | null = null;
    if (m.text) {
      // A reply carrying prose forwards the quote anchor (items 2,3) via
      // reply-route — the daemon picks the recognized origin pane or a LRU/MRU
      // picker. A reply whose text is a /command still runs the command verbatim.
      action =
        m.reply_to_message && !m.text.startsWith('/')
          ? {
              kind: 'reply-route',
              replyToMessageId: m.reply_to_message.message_id,
              injectText: buildReplyInject(m, name, opts),
              from: name,
            }
          : textAction(m.text, name, opts);
    } else if (m.photo?.length) action = photoAction(u.update_id, m, name);
    else if (m.document) action = documentAction(u.update_id, m, name);
    // Anything else (sticker, voice, …) → advance silently.
    if (action) {
      actions.push(action);
      // Delivery receipt (👀 reaction) follows every action that represents
      // handling the message — but NOT a pure error reply (e.g. the too-large
      // verdict): there the reply itself is the "did not land" signal.
      if (action.kind !== 'reply') actions.push({ kind: 'ack', messageId: m.message_id });
    }
  }

  return {
    actions: [...callbackActions, ...actions],
    newOffset: updates.length ? maxId + 1 : opts.currentOffset,
    skippedStale,
  };
}

function senderAllowed(sender: number | undefined, opts: StepOpts): boolean {
  return sender !== undefined && (sender === opts.chatId || opts.cfg.allowedSenders.includes(sender));
}

// Command-vs-prompt split (spec §13). Verbs match on the first whitespace
// token; unknown slash commands pass through VERBATIM so the harness
// interprets its own (/compact, /clear, …) — no wrap on those.
function textAction(text: string, name: string, opts: StepOpts): Action {
  if (text.startsWith('/')) {
    const verb = text.split(/\s+/, 1)[0];
    const cmd = verb.replace(/@\w+$/, ''); // tolerate /cmd@botname in groups
    if (cmd === '/stop') return { kind: 'inject-key', key: 'Escape' };
    if (cmd === '/kill') return { kind: 'kill-agent' };
    if (cmd === '/status') return { kind: 'status' };
    if (cmd === '/agent') {
      const p = parseAgentCommand(text);
      return { kind: 'agent-route', selector: p.selector, rest: p.rest, all: p.all, from: name };
    }
    return { kind: 'inject-text', text };
  }
  return { kind: 'inject-text', text: opts.wrap(name, text) };
}

function photoAction(updateId: number, m: TgMessage, name: string): Action {
  // Telegram sends several renditions; take the largest by file_size. Ties and
  // missing sizes resolve to the LATER entry — the array is size-ascending.
  let best = m.photo![0];
  for (const p of m.photo!) {
    if ((p.file_size ?? 0) >= (best.file_size ?? 0)) best = p;
  }
  if ((best.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return { kind: 'reply', text: TOO_LARGE_REPLY };
  return {
    kind: 'download-media',
    fileId: best.file_id,
    suggestedName: `${updateId}.jpg`,
    mediaKind: 'photo',
    fileSize: best.file_size,
    caption: m.caption,
    from: name,
  };
}

function documentAction(updateId: number, m: TgMessage, name: string): Action {
  const doc = m.document!;
  if ((doc.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return { kind: 'reply', text: TOO_LARGE_REPLY };
  return {
    kind: 'download-media',
    fileId: doc.file_id,
    suggestedName: `${updateId}.${sanitizedExt(doc.file_name)}`,
    mediaKind: 'document',
    fileSize: doc.file_size,
    caption: m.caption,
    from: name,
  };
}

// The saved filename is ALWAYS daemon-chosen — <update_id>.<ext> — and only
// the extension survives from the Telegram-supplied name, sanitized (spec
// §5.2: never trust the remote basename). Anything longer than 10 chars after
// sanitization is not a real extension; fall back to bin.
function sanitizedExt(fileName: string | undefined): string {
  const dot = fileName ? fileName.lastIndexOf('.') : -1;
  if (!fileName || dot === -1) return 'bin';
  const ext = fileName
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return ext && ext.length <= 10 ? ext : 'bin';
}

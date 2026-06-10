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

// Bot API getFile hard limit; larger files cannot be downloaded by bots.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const TOO_LARGE_REPLY = 'file too large for Bot API (>20 MB)';

export interface StepOpts {
  cfg: ControlConfig;
  chatId: number;
  nowSec: number;
  currentOffset: number; // returned as newOffset when the batch is empty
  wrap: (name: string, msg: string) => string;
}

export function stepUpdates(updates: TgUpdate[], opts: StepOpts): StepResult {
  const actions: Action[] = [];
  let skippedStale = 0;
  let maxId = -1;

  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const m = u.message;
    if (!m) continue; // non-message update → advance silently

    // Sender allowlist FIRST (spec §9: from.id, not chat id — a group member
    // must not inject prompts). Rejected senders also never inflate the stale
    // count, so the "skipped N stale" notice only reports the owner's backlog.
    const sender = m.from?.id;
    if (sender === undefined || (sender !== opts.chatId && !opts.cfg.allowedSenders.includes(sender))) {
      continue;
    }

    if (opts.nowSec - m.date > opts.cfg.stalenessSec) {
      skippedStale += 1;
      continue;
    }

    const name = m.from?.first_name || m.from?.username || 'tg';
    let action: Action | null = null;
    if (m.text) action = textAction(m.text, name, opts);
    else if (m.photo?.length) action = photoAction(u.update_id, m, name);
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
    actions,
    newOffset: updates.length ? maxId + 1 : opts.currentOffset,
    skippedStale,
  };
}

// Command-vs-prompt split (spec §13). Verbs match on the first whitespace
// token; unknown slash commands pass through VERBATIM so the harness
// interprets its own (/compact, /clear, …) — no wrap on those.
function textAction(text: string, name: string, opts: StepOpts): Action {
  if (text.startsWith('/')) {
    const verb = text.split(/\s+/, 1)[0];
    if (verb === '/stop') return { kind: 'inject-key', key: 'Escape' };
    if (verb === '/kill') return { kind: 'kill-agent' };
    if (verb === '/status') return { kind: 'status' };
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

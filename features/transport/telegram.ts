// --- Telegram Bot API transport ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 2, docs/specs/
// tg-decomposition.md). The main()-side closures captured the bot endpoint
// (API) + chat id (CHAT_ID) and the route recorder; here they arrive via
// createTelegramTransport(ctx). main() keeps recordRoute — it owns the daemon
// ROUTES_PATH / TMUX_PANE bookkeeping — and injects it. The returned object is
// exactly the transmitter's Transport (sendMessage/sendPhoto/sendDocument/
// sendMediaGroup); the transmitter drives caption-overflow, the >4096 split and
// the photos→text→documents ordering on top of it.
import { readFileSync, statSync } from 'fs';
import { BOM_MAX_BYTES, maybeAddBom } from '../auto-attach/encoding';
import { type Transport } from '../auto-attach/transmitter';
import { type SendItem } from '../auto-attach/types';
import { type EmojiEntity } from '../branding/emoji';
import { type Format } from '../cli/args';
import { convertEntitiesToHtml, parseModeFor } from '../render/html';
import { normalizeRichHtml, validateRichHtml } from '../render/rich';

export interface TelegramCtx {
  // Bot endpoint base, e.g. `https://api.telegram.org/bot<token>`.
  api: string;
  // Target chat id.
  chatId: string;
  // Best-effort route bookkeeping: main owns the daemon ROUTES_PATH/TMUX_PANE
  // state and injects this recorder. Called once per returned message id so a
  // reply to any sent message routes back to this pane.
  recordRoute: (messageId: number) => void;
  // Threaded reply target (`--reply-to <message_id>`). When set, the FIRST
  // outbound sendMessage carries reply_to_message_id so it threads UNDER that
  // inbound Telegram message. Only the first message is threaded — a >4096
  // split's continuation chunks must not each re-reply to the same anchor.
  replyToMessageId?: number;
}

// Exit-on-error response check, shared by every send. A non-2xx response or an
// { ok:false } body prints to stderr and exits 1; otherwise the `result`
// payload is returned (a Message or an array of Messages).
export async function checkResponse(resp: Response, method: string): Promise<unknown> {
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Telegram API error (${method}): ${resp.status} ${body}`);
    process.exit(1);
  }
  const json = (await resp.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) {
    console.error(`Telegram API error (${method}): ${json.description ?? 'unknown error'}`);
    process.exit(1);
  }
  return json.result;
}

// Upload bytes for an item. Text DOCUMENTS with non-ASCII UTF-8 content get
// a BOM prepended to the uploaded copy (features/auto-attach/encoding.ts) so
// Telegram's preview stops guessing legacy codepages for Cyrillic; the file
// on disk is never modified. Photos and big/binary files stream unchanged.
function blobFor(item: SendItem): { body: Blob | ReturnType<typeof Bun.file>; name?: string } {
  if (item.source.kind === 'memory') {
    const bytes = new TextEncoder().encode(item.source.content);
    const processed = item.type === 'document' ? maybeAddBom(bytes, item.source.filename) : bytes;
    return { body: new Blob([processed]), name: item.source.filename };
  }
  if (item.type === 'document') {
    try {
      const size = statSync(item.source.path).size;
      if (size > 0 && size <= BOM_MAX_BYTES) {
        const bytes = new Uint8Array(readFileSync(item.source.path));
        const processed = maybeAddBom(bytes, item.source.path);
        if (processed !== bytes) {
          const name = item.source.path.slice(item.source.path.lastIndexOf('/') + 1);
          return { body: new Blob([processed]), name };
        }
      }
    } catch {
      // unreadable here → let Bun.file surface the real error downstream
    }
  }
  return { body: Bun.file(item.source.path) };
}

// Build the transmitter's Transport bound to a bot endpoint + chat + route
// recorder. All four send primitives funnel their result through
// recordRouteFromResult so a reply to any sent message (including each item of
// a media group) routes back to the producing pane.
export function createTelegramTransport(ctx: TelegramCtx): Transport {
  const { api, chatId, recordRoute, replyToMessageId } = ctx;
  // A reply threads under ONE anchor: consume the target on the first
  // sendMessage so split-continuation chunks (and any later sends) do not each
  // re-reply to the same inbound message.
  let pendingReplyTo = replyToMessageId;

  // A Bot API send `result` is a Message (text/photo/document) or an array of
  // Messages (sendMediaGroup) — record a route for every message id so a reply
  // to ANY of them (including a media report) routes to this pane.
  const recordRouteFromResult = (result: unknown): void => {
    if (Array.isArray(result)) {
      for (const m of result) recordRouteFromResult(m);
      return;
    }
    if (result && typeof result === 'object' && typeof (result as { message_id?: unknown }).message_id === 'number') {
      recordRoute((result as { message_id: number }).message_id);
    }
  };

  const sendMessage = async (text: string, formatValue: Format, entities: EmojiEntity[]): Promise<void> => {
    const parseMode = parseModeFor(formatValue, text);
    let outText = text;
    if (parseMode && entities.length > 0) {
      outText = convertEntitiesToHtml(text, entities);
    }
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: outText,
    };
    if (parseMode) {
      body.parse_mode = parseMode;
    } else if (entities.length > 0) {
      body.entities = entities;
    }
    // Thread the FIRST message under the reply target, then clear it so
    // continuation chunks aren't all re-replied to the same anchor.
    if (pendingReplyTo !== undefined) {
      body.reply_to_message_id = pendingReplyTo;
      pendingReplyTo = undefined;
    }
    const resp = await fetch(`${api}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    recordRouteFromResult(await checkResponse(resp, 'sendMessage'));
  };

  // Rich message send (Bot API sendRichMessage). The HTML body is passed as
  // `rich_message.html` (NOT a parse_mode) — exactly one of html/markdown is
  // allowed. The body is first normalized (basic-only `<span class="tg-spoiler">`
  // → the rich `<tg-spoiler>` the rich parser accepts) and pre-flighted against
  // the documented limits locally, so a bad body fails with a clear message
  // instead of an opaque API 400. Threading uses `reply_parameters`
  // (sendRichMessage has no reply_to_message_id field); the first send consumes
  // the anchor, same as sendMessage.
  const sendRich = async (rawHtml: string): Promise<void> => {
    const html = normalizeRichHtml(rawHtml);
    const check = validateRichHtml(html);
    if (!check.ok) {
      console.error(`tg: ${check.error}`);
      process.exit(1);
    }
    const body: Record<string, unknown> = {
      chat_id: chatId,
      rich_message: { html },
    };
    if (pendingReplyTo !== undefined) {
      body.reply_parameters = { message_id: pendingReplyTo };
      pendingReplyTo = undefined;
    }
    const resp = await fetch(`${api}/sendRichMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    recordRouteFromResult(await checkResponse(resp, 'sendRichMessage'));
  };

  return {
    sendMessage: (text, fmt) => sendMessage(text, fmt, []),
    sendRich,
    sendPhoto: async (item, cap, fmt) => {
      const { body, name } = blobFor(item);
      const form = new FormData();
      form.append('chat_id', chatId);
      if (name) form.append('photo', body, name);
      else form.append('photo', body);
      const parseMode = parseModeFor(fmt, cap);
      if (cap) form.append('caption', cap);
      if (parseMode) form.append('parse_mode', parseMode);
      const resp = await fetch(`${api}/sendPhoto`, { method: 'POST', body: form });
      recordRouteFromResult(await checkResponse(resp, 'sendPhoto'));
    },
    sendDocument: async (item, cap, fmt) => {
      const { body, name } = blobFor(item);
      const form = new FormData();
      form.append('chat_id', chatId);
      if (name) form.append('document', body, name);
      else form.append('document', body);
      const parseMode = parseModeFor(fmt, cap);
      if (cap) form.append('caption', cap);
      if (parseMode) form.append('parse_mode', parseMode);
      const resp = await fetch(`${api}/sendDocument`, { method: 'POST', body: form });
      recordRouteFromResult(await checkResponse(resp, 'sendDocument'));
    },
    // Album send (FIX 2): 2..10 same-type items as a single Telegram media
    // group. Each item is uploaded as a multipart field and referenced from the
    // `media` JSON via `attach://<field>`. The caption (if any) rides the FIRST
    // InputMedia item — Telegram shows it as the album caption.
    sendMediaGroup: async (kind, mediaItems, cap, fmt) => {
      const form = new FormData();
      form.append('chat_id', chatId);
      const parseMode = parseModeFor(fmt, cap);
      const media = mediaItems.map((item, i) => {
        const { body, name } = blobFor(item);
        const field = `file${i}`;
        // A memory item needs an explicit filename so Telegram keeps the ext;
        // a disk item is uploaded under a stable field name (its own name is
        // carried by Bun.file). attach:// binds the JSON entry to the field.
        if (name) form.append(field, body, name);
        else form.append(field, body);
        const entry: Record<string, string> = { type: kind, media: `attach://${field}` };
        if (i === 0 && cap) {
          entry.caption = cap;
          if (parseMode) entry.parse_mode = parseMode;
        }
        return entry;
      });
      form.append('media', JSON.stringify(media));
      const resp = await fetch(`${api}/sendMediaGroup`, { method: 'POST', body: form });
      recordRouteFromResult(await checkResponse(resp, 'sendMediaGroup'));
    },
  };
}

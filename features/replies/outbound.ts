// Outbound text selection + history-record shaping for `tg replies`. PURE —
// the `tg` entrypoint knows the message body, attachment counts, and the ids
// Telegram assigned to what it just sent, and asks this module what to LOG.
// A photo/document-only send (no body) is logged with a placeholder so it
// still shows up in recall; a truly empty send (no body, no media — can't
// happen, the CLI rejects it) → null.

import type { HistoryRecord } from './history';

export interface OutboundAttachments {
  photos: number;
  documents: number;
}

// A mixed-media send (transmit orders photos, then documents — see
// features/auto-attach/transmitter.ts) with an empty body needs BOTH counts
// in the placeholder. This is still a per-SEND label, not a per-message one —
// with buildOutboundHistoryRecords now writing one record per outbound id
// (review: tg-cli#131), EVERY id of a mixed send (photo AND document ids
// alike) gets this same combined text, so recall-by-id shows "what the whole
// send contained", not "what this specific id was". Before this fix an
// empty-body mixed send silently dropped the document count from the
// placeholder entirely (photos-only won the old priority check); the
// combined form is strictly more informative, not a precise per-id label.
export function outboundHistoryText(body: string, attach: OutboundAttachments): string | null {
  const trimmed = body.trim();
  if (trimmed !== '') return body;
  const parts: string[] = [];
  if (attach.photos > 0) parts.push(attach.photos === 1 ? 'photo' : `${attach.photos} photos`);
  if (attach.documents > 0) parts.push(attach.documents === 1 ? 'document' : `${attach.documents} files`);
  return parts.length > 0 ? `[${parts.join(', ')}]` : null;
}

// One `agent` history record PER outbound Telegram message_id — a send that
// splits into several Telegram messages (a >4096 split, or a media-group
// album) gets one record per id, all carrying the same text, so a reply
// anchored to ANY of those ids stays recall-able via `tg replies --json |
// select(.id == <tg#>)`. `buildReplyAnchor` (features/tg-ctl/updates.ts)
// stamps the reply-quote anchor with whichever id the CTO actually replied
// to — that can be any chunk/item, not only the first. Recording only the
// first id left later chunks unrecoverable (review: tg-cli#131). Falls back
// to a single `message_id: null` record when the send reported no ids at all
// (the `tg` entrypoint only calls this once TMUX_PANE is confirmed set, so in
// practice this is a successful send whose API response carried no
// message_id, not the outside-tmux case — that returns before ever reaching
// here. Unchanged from before this fix). Ids are de-duplicated (order
// preserved) so a caller that ever reports the same message_id twice (a
// retry, a defensive double-record) still logs exactly one history row per
// real Telegram message, matching routes.ts's own dedupe-by-id invariant
// (appendRoute) instead of a naive push.
export function buildOutboundHistoryRecords(
  outboundIds: number[],
  text: string,
  ts: number,
  pane: string,
): HistoryRecord[] {
  const uniqueIds = [...new Set(outboundIds)];
  const ids: (number | null)[] = uniqueIds.length > 0 ? uniqueIds : [null];
  return ids.map((message_id) => ({
    ts,
    message_id,
    direction: 'agent',
    from: 'agent',
    text,
    pane,
  }));
}

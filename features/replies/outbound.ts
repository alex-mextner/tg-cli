// Outbound text selection for `tg replies` history. PURE — the `tg` entrypoint
// knows the message body + attachment counts and asks this what to LOG, then
// appends ONE `agent` record (the whole send is one logical message, even when
// it splits into several Telegram messages). A photo/document-only send (no
// body) is logged with a placeholder so it still shows up in recall; a truly
// empty send (no body, no media — can't happen, the CLI rejects it) → null.

export interface OutboundAttachments {
  photos: number;
  documents: number;
}

export function outboundHistoryText(body: string, attach: OutboundAttachments): string | null {
  const trimmed = body.trim();
  if (trimmed !== '') return body;
  if (attach.photos > 0) return attach.photos === 1 ? '[photo]' : `[${attach.photos} photos]`;
  if (attach.documents > 0) return attach.documents === 1 ? '[document]' : `[${attach.documents} files]`;
  return null;
}

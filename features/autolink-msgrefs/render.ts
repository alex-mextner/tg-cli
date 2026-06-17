// Post-render linkify for the autolink-msgrefs feature (tg#28).
//
// Turns each `tg#<id>` message reference in an already-rendered HTML body into
// either a clickable link (when a deep link is possible) or a visually-marked
// styled reference (when it is not). Same tag-safe walk as the sibling autolink
// features: never rewrites inside <a>/<pre>/<code> or a token containing "://".
//
// Telegram message deep links only exist for SUPERGROUPS: a chat id of the form
// `-100<rest>` maps to https://t.me/c/<rest>/<id>. A private bot DM (a positive
// chat id) has NO public per-message URL, so there the reference cannot be a
// link — we still mark it (bold-italic, like the autolink task title) so it
// reads as a deliberate reference rather than stray text.

import { escapeHtml, toBoldItalic } from '../prefix-style/style';
import { findMsgRefMatches } from './detect';

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/**
 * Build the t.me deep link for inbound message `id` in `chatId`, or null when
 * no public link exists. Only SUPERGROUP chats (id `-100<rest>`) have one:
 * https://t.me/c/<rest>/<id>. Channels share that shape. A private DM (positive
 * id) or a basic group (a `-<digits>` id without the `-100` prefix) returns null.
 */
export function msgRefUrl(chatId: string | undefined, id: number): string | null {
  if (!chatId) return null;
  const m = chatId.match(/^-100(\d+)$/);
  if (!m) return null;
  return `https://t.me/c/${m[1]}/${id}`;
}

/** The marked-but-unlinked rendering of a `tg#<id>` token (no deep link). The
 *  bold-italic Unicode keeps it visible as a reference; a foreign-letter
 *  fallback never triggers here (the token is ASCII), so this always escapes
 *  cleanly. */
function styledRef(token: string): string {
  const uni = toBoldItalic(token);
  return uni !== null ? escapeHtml(uni) : `<i>${escapeHtml(token)}</i>`;
}

/**
 * Linkify verified `tg#<id>` references in `html`. `urlFor(id)` returns the deep
 * link or null; a non-null url wraps the token in <a href>, a null url renders
 * the marked-but-unlinked styled form. Walks the markup tag-by-tag and only
 * rewrites text segments that are NOT inside <a>…</a> (Telegram rejects nested
 * links), NOT inside <pre>/<code>, and NOT part of a token containing "://".
 */
export function linkifyMsgRefs(html: string, urlFor: (id: number) => string | null): string {
  const parts = html.split(/(<[^>]*>)/);
  let aDepth = 0;
  let preDepth = 0;
  let out = '';
  for (const part of parts) {
    if (part.startsWith('<')) {
      const name = part.match(/^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/)?.[1]?.toLowerCase();
      const closing = part.startsWith('</');
      if (name === 'a') aDepth = Math.max(0, aDepth + (closing ? -1 : 1));
      if (name === 'pre' || name === 'code') preDepth = Math.max(0, preDepth + (closing ? -1 : 1));
      out += part;
      continue;
    }
    if (aDepth > 0 || preDepth > 0) {
      out += part;
      continue;
    }
    out += linkifyTextSegment(part, urlFor);
  }
  return out;
}

function linkifyTextSegment(text: string, urlFor: (id: number) => string | null): string {
  // Odd indices are the whitespace separators (capture group), even are tokens.
  const pieces = text.split(/(\s+)/);
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (i % 2 === 1 || !piece || piece.includes('://')) {
      out += piece;
      continue;
    }
    let rebuilt = '';
    let cursor = 0;
    for (const { start, end, id } of findMsgRefMatches(piece)) {
      const token = piece.slice(start, end);
      const url = urlFor(id);
      const replacement = url ? `<a href="${escapeAttr(url)}">${escapeHtml(token)}</a>` : styledRef(token);
      rebuilt += piece.slice(cursor, start) + replacement;
      cursor = end;
    }
    out += rebuilt + piece.slice(cursor);
  }
  return out;
}

// Post-render message transform for the autolink-tasks feature (spec
// §Rendering). Runs on the ALREADY-RENDERED HTML body (the tg entrypoint
// forces HTML whenever verified tickets exist, same as line-spec quotes), and
// BEFORE line-spec quote insertion so injected <pre> bodies are never touched.

import { findCodeMatches } from './detect';
import type { TicketInfo } from './linear';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function anchor(ticket: TicketInfo): string {
  return `<a href="${escapeAttr(ticket.url)}">${ticket.code}</a>`;
}

/**
 * Replace verified-code occurrences in `html` with <a href> links. Walks the
 * markup tag-by-tag and only rewrites text segments that are:
 *   - not inside an <a>…</a> (Telegram rejects nested links),
 *   - not inside <pre>/<code> (no nested entities allowed there),
 *   - not part of a token containing "://" (don't corrupt pasted URLs).
 * Tag bodies themselves (attributes) are copied verbatim.
 */
export function linkifyCodes(html: string, tickets: Map<string, TicketInfo>): string {
  if (tickets.size === 0) return html;
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
    out += linkifyTextSegment(part, tickets);
  }
  return out;
}

function linkifyTextSegment(text: string, tickets: Map<string, TicketInfo>): string {
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
    for (const { start, end, code } of findCodeMatches(piece)) {
      const ticket = tickets.get(code);
      if (!ticket) continue;
      rebuilt += piece.slice(cursor, start) + anchor(ticket);
      cursor = end;
    }
    out += rebuilt + piece.slice(cursor);
  }
  return out;
}

/**
 * Full autolink transform of a rendered message body:
 *   1. linkify every verified code in place;
 *   2. one ticket → its (escaped) title on the first line: appended after the
 *      emoji/[window] prefix when one exists, otherwise as its own first line;
 *   3. several tickets → a collapsed <blockquote expandable> reference block
 *      appended at the end, one "CODE: title" line per ticket (codes linked).
 * `tickets` is in first-appearance order. Empty → body returned unchanged.
 */
export function applyAutolink(body: string, tickets: TicketInfo[], hasPrefixLine: boolean): string {
  if (tickets.length === 0) return body;
  let out = linkifyCodes(body, new Map(tickets.map((t) => [t.code, t])));

  if (tickets.length === 1) {
    const title = escapeHtml(tickets[0].title);
    if (hasPrefixLine) {
      const lines = out.split('\n');
      lines[0] = `${lines[0]} ${title}`;
      out = lines.join('\n');
    } else {
      out = `${title}\n${out}`;
    }
    return out;
  }

  const refLines = tickets.map((t) => `${anchor(t)}: ${escapeHtml(t.title)}`);
  return `${out}\n<blockquote expandable>${refLines.join('\n')}</blockquote>`;
}

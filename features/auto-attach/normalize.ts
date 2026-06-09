// Pre-send normalization layer (spec §Architecture #2).
//
// Turns parsed items + a (already emoji/prefix-rendered) caption text into an
// ordered SendPlan. This phase-3 version handles the base mapping:
//   - explicit/auto items → photos[] / documents[] (preserving order: photos
//     keep their relative order, documents keep theirs)
//   - the caption becomes a single TextMessage (if non-empty)
// The R2/R3/R4 text-rewriting rules are layered in here in later phases; this
// step deliberately does NOT touch the text body beyond passing it through.

import type { Format, SendItem, SendPlan, TextMessage } from './types';

export interface ParsedItem {
  type: 'photo' | 'document';
  path: string;
}

export function buildSendPlan(items: ParsedItem[], text: string, format: Format): SendPlan {
  const photos: SendItem[] = [];
  const documents: SendItem[] = [];
  for (const it of items) {
    const sendItem: SendItem = { type: it.type, source: { kind: 'disk', path: it.path } };
    if (it.type === 'photo') photos.push(sendItem);
    else documents.push(sendItem);
  }
  const textMessages: TextMessage[] = text ? [{ text, format }] : [];
  return { photos, textMessages, documents };
}

// Generic transmitter (spec §Architecture #3).
//
// The ONLY layer that knows about Telegram's length limits. It consumes a fully
// normalized SendPlan and a Transport (the injectable set of send primitives —
// real ones hit the API, fakes record calls for tests). It applies, in order:
//   - the photos → text → documents "sandwich" (spec §Ordering)
//   - caption overflow: a caption that exceeds 1024, or that would need
//     splitting, is NOT used as media caption; instead the media is sent
//     caption-less and the text becomes separate message(s) (spec §Caption)
//   - the generic >4096 HTML-safe split, applied LAST (spec §Message splitting)
//
// These are transmitter-level SAFETY NETS: they run even when the auto-attach
// feature is OFF, because they are not part of the feature — they are correct
// behavior for any send.

import { splitMessage } from './split';
import { CAPTION_LIMIT, MESSAGE_LIMIT, type Format, type SendItem, type SendPlan } from './types';

export interface Transport {
  sendMessage(text: string, format: Format): Promise<void>;
  sendPhoto(item: SendItem, caption: string | undefined, format: Format): Promise<void>;
  sendDocument(item: SendItem, caption: string | undefined, format: Format): Promise<void>;
}

// Can the single text message ride as a media caption? Only when there is
// exactly one text message and it fits within the caption limit.
function captionCandidate(plan: SendPlan): { text: string; format: Format } | null {
  if (plan.textMessages.length !== 1) return null;
  const m = plan.textMessages[0];
  if (m.text.length > CAPTION_LIMIT) return null;
  return m;
}

async function sendText(text: string, format: Format, t: Transport): Promise<void> {
  for (const chunk of splitMessage(text, MESSAGE_LIMIT)) {
    await t.sendMessage(chunk, format);
  }
}

export async function transmit(plan: SendPlan, t: Transport): Promise<void> {
  const hasMedia = plan.photos.length > 0 || plan.documents.length > 0;
  const riding = hasMedia ? captionCandidate(plan) : null;
  // The text becomes a media caption only when it's a ride candidate. Otherwise
  // it is sent as separate (possibly split) message(s) in the sandwich middle.
  const captionText = riding ? riding.text : undefined;
  const captionFormat = riding ? riding.format : 'plain';

  // The first media item carries the caption (photos take priority over docs).
  const captionHost: SendItem | null = riding ? (plan.photos[0] ?? plan.documents[0] ?? null) : null;

  // 1. Photos.
  for (const photo of plan.photos) {
    const cap = photo === captionHost ? captionText : undefined;
    const fmt = photo === captionHost ? captionFormat : 'plain';
    await t.sendPhoto(photo, cap, fmt);
  }

  // 2. Text — only as separate message(s) when it did NOT ride as a caption.
  if (!riding) {
    for (const m of plan.textMessages) {
      await sendText(m.text, m.format, t);
    }
  }

  // 3. Documents.
  for (const document of plan.documents) {
    const cap = document === captionHost ? captionText : undefined;
    const fmt = document === captionHost ? captionFormat : 'plain';
    await t.sendDocument(document, cap, fmt);
  }
}

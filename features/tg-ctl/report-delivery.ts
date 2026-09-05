// features/tg-ctl/report-delivery.ts — pure helpers for delivering a multi-chunk daemon
// report (/daily, /spend) over Telegram without losing it (tg-cli#290 review findings).
//
// Two failure modes this covers:
//   1. A report longer than Telegram's 4096-char message limit — the entrypoint splits it
//      with the shared `splitMessage` (features/auto-attach/split.ts) and sends the chunks
//      in order.
//   2. A send that fails part-way. `rig daily` advances its own saved watermark while it
//      GENERATES the report (there is no separate "commit after send" verb — `--dry-run` and
//      `--since` are read-only), so a report whose Telegram send fails would otherwise be
//      gone for good: the next /daily reports "nothing new". Instead, the UNDELIVERED tail
//      (from the first failed chunk onward — the delivered chunks must not be repeated) is
//      persisted by the entrypoint and prepended to the next /daily reply.

// The chunks Telegram did NOT accept, joined back into one report body, or null when
// everything (or nothing at all — an empty report) was delivered.
export function undeliveredReportTail(chunks: string[], delivered: number): string | null {
  if (delivered >= chunks.length) return null;
  return chunks.slice(Math.max(0, delivered)).join('');
}

export const PENDING_DAILY_HEADER = 'daily: undelivered from the previous run (the Telegram send failed then):';

// The body for a /daily reply: a previously undelivered report first (clearly labelled as
// such, so it is never mistaken for new activity), then the fresh one.
export function mergePendingDailyReport(pending: string | null, fresh: string): string {
  let carried = pending?.trim() ?? '';
  // A persisted tail may itself start with this header (the first chunk of a previous
  // merged reply failed) — strip it so repeated failures never nest headers.
  if (carried.startsWith(PENDING_DAILY_HEADER)) carried = carried.slice(PENDING_DAILY_HEADER.length).trim();
  if (!carried) return fresh;
  return `${PENDING_DAILY_HEADER}\n${carried}\n\n${fresh}`;
}

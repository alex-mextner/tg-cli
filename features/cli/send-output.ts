/**
 * @file Formats the stable stdout line printed after a successful `tg` send.
 *
 * Accessed via: the `tg` entrypoint after the transmit step completes and all
 * Telegram message ids have been recorded from successful Bot API responses.
 *
 * Assumptions: callers pass ids from one chat send in wire order; an empty id
 * list falls back to the historic `OK` output. Invalid ids are ignored
 * defensively for direct helper callers; production ids are transport-validated.
 */
export function formatSendOk(messageIds: readonly number[]): string {
  const refs: string[] = [];
  for (const id of messageIds) {
    if (!Number.isInteger(id) || id <= 0) continue;
    refs.push(`tg#${id}`);
  }
  return refs.length > 0 ? `OK ${refs.join(' ')}` : 'OK';
}

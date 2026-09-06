// The per-agent Stop-hook inbox on disk (tg-cli#306) — PURE: paths, the entry shape,
// serialization and the fail-soft parser. The tg-ctl entrypoint owns the I/O
// (mkdir/append/rename), the agent-tools Stop hook owns the CONSUMING side.
//
// Layout (see unreachable.ts for the key contract shared with agent-tools):
//   <configDir>/inbox/<key>/pending.jsonl            daemon appends; hook claims + consumes
//   <configDir>/inbox/<key>/delivered-<pid>-<ts>.jsonl  ONE file per hook consumption,
//                                                    written whole (temp + rename)
//   <configDir>/inbox/<key>/acked.jsonl              daemon appends after reacting
// pending.jsonl is append-only JSONL: the daemon appends ONE complete line per write
// call so a concurrent reader never sees a torn record, and the hook CLAIMS it by
// renaming (atomic on POSIX) before reading, so append-after-claim lands in a fresh
// file. The hook → daemon direction deliberately has NO shared append target: a
// shared `delivered.jsonl` the daemon claimed by rename could be renamed + unlinked
// between the hook's open() and write() and the record would land on a dead inode
// (review finding). A complete per-run file that appears atomically cannot be torn
// or lost. Directories are 0700 and files 0600 — the content is the user's private
// Telegram text.

import { join } from 'path';

export interface InboxEntry {
  id: number | null; // Telegram message_id (for the delivered reaction), null if synthetic
  ts: string; // ISO-8601 UTC, when the daemon queued it
  from: string; // sender display name (the `{name}` of the inject wrap)
  text: string; // raw message text
  wrapped: string; // the exact text the agent should receive (inject-wrap applied)
}

export interface DeliveredEntry extends InboxEntry {
  delivered_ts?: string;
  session_id?: string;
  malformed?: boolean;
}

export const INBOX_DIRNAME = 'inbox';
export const PENDING_FILE = 'pending.jsonl';
export const DELIVERED_PREFIX = 'delivered-';
export const ACKED_FILE = 'acked.jsonl';
export const INBOX_DIR_MODE = 0o700;
export const INBOX_FILE_MODE = 0o600;

// A complete delivered batch the hook published (`delivered-<pid>-<ts>.jsonl`); its
// temp file (`.tmp` suffix) is still being written and must be left alone.
export function isDeliveredBatchFile(name: string): boolean {
  return name.startsWith(DELIVERED_PREFIX) && name.endsWith('.jsonl');
}

export function inboxRoot(configDir: string): string {
  return join(configDir, INBOX_DIRNAME);
}

export function inboxDirFor(configDir: string, key: string): string {
  return join(inboxRoot(configDir), key);
}

// One line, newline-terminated, never containing a raw newline (JSON escapes them).
export function serializeInboxEntry(entry: InboxEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

// Parse JSONL leniently: a malformed line is reported (not thrown) so one bad record
// never hides the good ones behind it. Only objects carrying a string `wrapped` count
// as entries; anything else is `malformed`.
export function parseInboxLines(text: string): { entries: DeliveredEntry[]; malformed: number } {
  const entries: DeliveredEntry[] = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj && typeof obj === 'object' && typeof (obj as { wrapped?: unknown }).wrapped === 'string') {
        entries.push(obj as DeliveredEntry);
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

// Message ids the daemon still has to react on: delivered by the hook, not malformed,
// carrying a real Telegram id. Deduplicated (a re-delivered id reacts once).
export function idsToAck(delivered: DeliveredEntry[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const e of delivered) {
    if (e.malformed || typeof e.id !== 'number' || !Number.isInteger(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    ids.push(e.id);
  }
  return ids;
}

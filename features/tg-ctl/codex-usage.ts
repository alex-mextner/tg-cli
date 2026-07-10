// Best-effort Codex usage collector for tg-cli#176.
//
// Codex documents Stop-hook `transcript_path`, but explicitly does not make the
// transcript JSONL format a stable hook interface. Current Codex CLI rollouts
// persist `event_msg` / `token_count` records with `rate_limits`; this module
// recognizes only that already-supported telemetry contract and ignores generic
// token counts so the hook cannot invent quota warnings from unsupported data.

import { extractUsageLimitEvents } from './limits';

export interface CodexUsageCollectOptions {
  now?: number;
}

function jsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function recordField(rec: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = rec[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function directTokenCountRateLimitId(rec: Record<string, unknown>): string | null {
  const sources = [rec, recordField(rec, 'payload'), recordField(rec, 'msg')];
  for (const source of sources) {
    if (!source || source.type !== 'token_count') continue;
    const rateLimits = recordField(source, 'rate_limits');
    const id = rateLimits?.limit_id ?? rateLimits?.limitId;
    if (typeof id === 'string' && id.trim()) return id;
  }
  return null;
}

function isCodexPlanRateLimitLine(line: string): boolean {
  const rec = jsonRecord(line);
  if (!rec) return false;
  const id = directTokenCountRateLimitId(rec);
  return id === null || id === 'codex';
}

export function codexUsageTranscriptPath(hookPayloadText: string): string | null {
  const rec = jsonRecord(hookPayloadText);
  if (!rec) return null;
  const path = rec.transcript_path;
  return typeof path === 'string' && path.trim() ? path : null;
}

export function latestCodexUsageTelemetryPayload(transcriptText: string, opts: CodexUsageCollectOptions = {}): string | null {
  const lines = transcriptText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!isCodexPlanRateLimitLine(line)) continue;
    if (extractUsageLimitEvents(line, { agent: 'codex', now: opts.now }).length > 0) return line;
  }
  return null;
}

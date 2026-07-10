import { expect, test } from 'bun:test';
import {
  codexUsageTranscriptPath,
  latestCodexUsageTelemetryPayload,
} from '../features/tg-ctl/codex-usage';

const NOW = new Date(2026, 6, 2, 12, 0, 0, 0).getTime();

test('Codex usage hook reads transcript_path from the documented hook envelope', () => {
  expect(codexUsageTranscriptPath(JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'abc123',
    transcript_path: '/Users/me/.codex/sessions/run.jsonl',
  }))).toBe('/Users/me/.codex/sessions/run.jsonl');
});

test('Codex usage collector picks the newest supported token_count sample', () => {
  const oldReset = Math.floor((NOW + 60 * 60_000) / 1000);
  const newReset = Math.floor((NOW + 2 * 60 * 60_000) / 1000);
  const transcript = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'ignored' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 91, window_minutes: 300, resets_at: oldReset },
        },
      },
    }),
    'not json',
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 89, window_minutes: 300, resets_at: newReset },
          secondary: { used_percent: 64, window_minutes: 10080, resets_at: newReset + 3600 },
        },
      },
    }),
  ].join('\n');

  const payload = latestCodexUsageTelemetryPayload(transcript, { now: NOW });
  expect(payload).not.toBeNull();
  expect(payload).toContain('"used_percent":89');
  expect(payload).not.toContain('"used_percent":91');
});

test('Codex usage collector skips model-specific direct limit_id samples', () => {
  const reset = Math.floor((NOW + 60 * 60_000) / 1000);
  const transcript = [
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 96, window_minutes: 300, resets_at: reset },
        },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex_bengalfox',
          primary: { used_percent: 0, window_minutes: 300, resets_at: reset },
        },
      },
    }),
  ].join('\n');

  const payload = latestCodexUsageTelemetryPayload(transcript, { now: NOW });
  expect(payload).not.toBeNull();
  expect(payload).toContain('"limit_id":"codex"');
  expect(payload).toContain('"used_percent":96');
  expect(payload).not.toContain('codex_bengalfox');
});

test('Codex usage collector ignores generic token-only transcript events', () => {
  const transcript = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1234 } } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'done' } }),
  ].join('\n');

  expect(latestCodexUsageTelemetryPayload(transcript, { now: NOW })).toBeNull();
});

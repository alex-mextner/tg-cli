// tests/ctl-report-delivery.test.ts — the pure undelivered-tail / pending-merge helpers
// behind the /daily and /spend replies (tg-cli#290 review findings: >4096 split + a failed
// send must not lose a report whose `rig daily` watermark already advanced).
import { expect, test } from 'bun:test';
import { MESSAGE_LIMIT } from '../features/auto-attach/types';
import { splitMessage } from '../features/auto-attach/split';
import {
  PENDING_DAILY_HEADER,
  mergePendingDailyReport,
  undeliveredReportTail,
} from '../features/tg-ctl/report-delivery';

test('undeliveredReportTail: everything delivered → nothing to persist', () => {
  expect(undeliveredReportTail(['a', 'b'], 2)).toBeNull();
  expect(undeliveredReportTail([], 0)).toBeNull();
});

test('undeliveredReportTail: persists ONLY from the first failed chunk onward (no duplicate of delivered ones)', () => {
  expect(undeliveredReportTail(['one\n', 'two\n', 'three'], 1)).toBe('two\nthree');
  expect(undeliveredReportTail(['one\n', 'two\n', 'three'], 0)).toBe('one\ntwo\nthree');
});

test('a long plain report splits into ≤4096-char chunks that reassemble losslessly', () => {
  const report = Array.from({ length: 300 }, (_, i) => `- merged PR #${i}: a fact line about it (#${i})`).join('\n');
  expect(report.length).toBeGreaterThan(MESSAGE_LIMIT);
  const chunks = splitMessage(report, MESSAGE_LIMIT, 'plain');
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  // The tail after a partial delivery is exactly the not-yet-sent remainder of the report.
  expect(chunks.join('')).toBe(report);
  expect(undeliveredReportTail(chunks, 1)).toBe(report.slice(chunks[0].length));
});

test('mergePendingDailyReport: no pending → the fresh report verbatim', () => {
  expect(mergePendingDailyReport(null, 'fresh')).toBe('fresh');
  expect(mergePendingDailyReport('', 'fresh')).toBe('fresh');
  expect(mergePendingDailyReport('  \n', 'fresh')).toBe('fresh');
});

test('mergePendingDailyReport: a carried-over report is labelled and comes BEFORE the fresh one', () => {
  const out = mergePendingDailyReport('old report', 'fresh report');
  expect(out.startsWith(PENDING_DAILY_HEADER)).toBe(true);
  expect(out.indexOf('old report')).toBeLessThan(out.indexOf('fresh report'));
  expect(out).toBe(`${PENDING_DAILY_HEADER}\nold report\n\nfresh report`);
});

test('mergePendingDailyReport: a carried tail that already starts with the header is not double-wrapped', () => {
  const carried = `${PENDING_DAILY_HEADER}\nolder report`;
  const out = mergePendingDailyReport(carried, 'fresh');
  expect(out).toBe(`${PENDING_DAILY_HEADER}\nolder report\n\nfresh`);
  expect(out.split(PENDING_DAILY_HEADER).length - 1).toBe(1);
});

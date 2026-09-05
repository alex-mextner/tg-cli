// tests/ctl-usage-format.test.ts — the pure `rig usage --json` → /spend text contract
// (tg-cli#290 review: the formatter and its shape guard used to live untested in the
// entrypoint; the "unpriced period renders as unpriced, not ~$0.00" fix had no test).
import { expect, test } from 'bun:test';
import { formatTokenCount, formatUsagePeriod, normalizeUsagePeriodReport, renderUsageReport } from '../features/tg-ctl/usage-format';

const totals = (n: number) => ({ input_tokens: n, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, total_tokens: n + 6 });

function period(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    period: 'week',
    label: '2026-W35',
    totals: totals(1_500_000),
    estimated_cost_usd: 12.5,
    all_models_unpriced: false,
    by_model: {
      'claude-opus-4-8': { totals: totals(1_000_000), estimated_cost_usd: 10 },
      '<synthetic>': { totals: totals(5), estimated_cost_usd: null },
      'idle-model': { totals: { ...totals(0), total_tokens: 0 }, estimated_cost_usd: 0 },
    },
    ...overrides,
  };
}

test('formatTokenCount: K/M/B suffixes, small numbers verbatim', () => {
  expect(formatTokenCount(999)).toBe('999');
  expect(formatTokenCount(1_500)).toBe('1.5K');
  expect(formatTokenCount(2_345_678)).toBe('2.35M');
  expect(formatTokenCount(3_000_000_000)).toBe('3.00B');
});

test('formatUsagePeriod: priced period shows ~$cost, skips <synthetic> and zero-token models', () => {
  const p = normalizeUsagePeriodReport(period());
  expect(p).not.toBeNull();
  const out = formatUsagePeriod(p!);
  expect(out).toContain('week 2026-W35: 1.50M tokens, ~$12.50');
  expect(out).toContain('top models: claude-opus-4-8 $10.00');
  expect(out).not.toContain('<synthetic>');
  expect(out).not.toContain('idle-model');
});

test('formatUsagePeriod: an all-unpriced period renders as unpriced, NOT "~$0.00"', () => {
  // rig emits estimated_cost_usd: 0.0 together with all_models_unpriced: true for a period
  // whose only activity is on a model without a known price.
  const p = normalizeUsagePeriodReport(period({ estimated_cost_usd: 0, all_models_unpriced: true }))!;
  expect(formatUsagePeriod(p)).toContain('n/a (unpriced model)');
  expect(formatUsagePeriod(p)).not.toContain('~$0.00');
  const nullCost = normalizeUsagePeriodReport(period({ estimated_cost_usd: null }))!;
  expect(formatUsagePeriod(nullCost)).toContain('n/a (unpriced model)');
});

test('normalizeUsagePeriodReport: accept/reject table', () => {
  expect(normalizeUsagePeriodReport(period())).not.toBeNull();
  // Absent optional keys are tolerated (a rig-cli that omits them for an unpriced period)…
  const absent = normalizeUsagePeriodReport(period({ estimated_cost_usd: undefined, all_models_unpriced: undefined, by_model: undefined }));
  expect(absent).toMatchObject({ estimated_cost_usd: null, all_models_unpriced: false, by_model: {} });
  // …but wrong TYPES are rejected rather than thrown on mid-format.
  expect(normalizeUsagePeriodReport(period({ totals: null }))).toBeNull();
  expect(normalizeUsagePeriodReport(period({ totals: { ...totals(1), total_tokens: '7' } }))).toBeNull();
  expect(normalizeUsagePeriodReport(period({ estimated_cost_usd: 'free' }))).toBeNull();
  expect(normalizeUsagePeriodReport(period({ all_models_unpriced: 'yes' }))).toBeNull();
  expect(normalizeUsagePeriodReport(period({ by_model: [1] }))).toBeNull();
  expect(normalizeUsagePeriodReport(period({ by_model: { x: { totals: null, estimated_cost_usd: 1 } } }))).toBeNull();
  expect(normalizeUsagePeriodReport(period({ label: 7 }))).toBeNull();
  expect(normalizeUsagePeriodReport(null)).toBeNull();
  expect(normalizeUsagePeriodReport([period()])).toBeNull();
  expect(normalizeUsagePeriodReport('week')).toBeNull();
});

test('renderUsageReport: ok report joins periods and appends the disclaimer verbatim', () => {
  const stdout = JSON.stringify({
    disclaimer: 'Hypothetical estimate at API list prices — not a bill.',
    periods: { week: period(), month: period({ period: 'month', label: '2026-08' }) },
  });
  const r = renderUsageReport(stdout);
  expect(r.ok).toBe(true);
  expect(r.text).toContain('week 2026-W35:');
  expect(r.text).toContain('month 2026-08:');
  expect(r.text.endsWith('Hypothetical estimate at API list prices — not a bill.')).toBe(true);
});

test('normalizeUsagePeriodReport: rejects Infinity/NaN-shaped numbers from adversarial JSON (e.g. 1e999)', () => {
  // JSON.parse("1e999") === Infinity; JSON.parse("-1e999") === -Infinity. A malformed
  // period must be dropped, not rendered as "InfinityB tokens, ~$Infinity".
  expect(normalizeUsagePeriodReport(period({ totals: { ...totals(1), total_tokens: Infinity } }))).toBeNull();
  expect(normalizeUsagePeriodReport(period({ estimated_cost_usd: Infinity }))).toBeNull();
  expect(normalizeUsagePeriodReport(period({ estimated_cost_usd: -Infinity }))).toBeNull();
  expect(normalizeUsagePeriodReport(period({ estimated_cost_usd: NaN }))).toBeNull();
  expect(
    normalizeUsagePeriodReport(period({ by_model: { x: { totals: totals(1), estimated_cost_usd: Infinity } } })),
  ).toBeNull();
});

test('renderUsageReport: garbage, no periods, or all-malformed periods → ok:false with an explanation (never throws)', () => {
  expect(renderUsageReport('not json')).toMatchObject({ ok: false });
  expect(renderUsageReport('null')).toMatchObject({ ok: false });
  expect(renderUsageReport('{"periods":{}}')).toMatchObject({ ok: false });
  const allBad = renderUsageReport(JSON.stringify({ periods: { week: period({ totals: null }) } }));
  expect(allBad.ok).toBe(false);
  expect(allBad.text).toContain('no period data');
  // One bad period among good ones is dropped, not fatal.
  const mixed = renderUsageReport(JSON.stringify({ periods: { week: period({ totals: null }), month: period({ period: 'month', label: '2026-08' }) } }));
  expect(mixed.ok).toBe(true);
  expect(mixed.text).toContain('month 2026-08:');
  expect(mixed.text).not.toContain('week 2026-W35');
});

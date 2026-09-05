// features/tg-ctl/usage-format.ts — pure rendering of `rig usage --json` into the /spend
// reply (and the scheduled push's body). The entrypoint owns the spawn; this module owns
// the JSON contract with rig-cli (riglib/usage.py) and the text, so both are unit-tested.

export interface UsagePeriodTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
}

export interface UsagePeriodReport {
  period: string;
  label: string;
  totals: UsagePeriodTotals;
  estimated_cost_usd: number | null;
  all_models_unpriced: boolean;
  by_model: Record<string, { totals: UsagePeriodTotals; estimated_cost_usd: number | null }>;
}

// Compact K/M/B suffix formatting for token counts — `rig usage`'s raw totals run into
// the billions and a bare number is unreadable in a chat message.
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// `JSON.parse` happily produces `Infinity`/`NaN`-shaped surprises from adversarial input
// (`1e999` parses to `Infinity`; `-1e999` to `-Infinity`) — reject those rather than
// rendering "InfinityB tokens, ~$Infinity" as if it were a real report.
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidUsageTotals(v: unknown): v is UsagePeriodTotals {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    isFiniteNumber(t.input_tokens) &&
    isFiniteNumber(t.output_tokens) &&
    isFiniteNumber(t.cache_creation_input_tokens) &&
    isFiniteNumber(t.cache_read_input_tokens) &&
    isFiniteNumber(t.total_tokens)
  );
}

// A cost field is a number or null; an ABSENT key (a rig-cli version that omits it for an
// unpriced period) reads as null rather than rejecting the whole period.
function costOf(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return isFiniteNumber(v) ? v : undefined;
}

// Runtime validation + normalization of one entry of `rig usage --json`'s `periods` map —
// the shape isn't guaranteed by anything but rig-cli's own contract, and a malformed or
// future-shape value must not throw mid-format: the daemon persists the Telegram update
// offset BEFORE running the action, so an uncaught throw drops the /spend request with no
// reply, not just a bad message. Returns null for an unusable period.
export function normalizeUsagePeriodReport(v: unknown): UsagePeriodReport | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.period !== 'string' || typeof r.label !== 'string') return null;
  if (!isValidUsageTotals(r.totals)) return null;
  const cost = costOf(r.estimated_cost_usd);
  if (cost === undefined) return null;
  if (r.all_models_unpriced !== undefined && typeof r.all_models_unpriced !== 'boolean') return null;
  const byModel: UsagePeriodReport['by_model'] = {};
  const rawModels = r.by_model === undefined ? {} : r.by_model;
  if (!rawModels || typeof rawModels !== 'object' || Array.isArray(rawModels)) return null;
  for (const [name, m] of Object.entries(rawModels as Record<string, unknown>)) {
    if (!m || typeof m !== 'object') return null;
    const mm = m as Record<string, unknown>;
    const mCost = costOf(mm.estimated_cost_usd);
    if (mCost === undefined || !isValidUsageTotals(mm.totals)) return null;
    byModel[name] = { totals: mm.totals, estimated_cost_usd: mCost };
  }
  return {
    period: r.period,
    label: r.label,
    totals: r.totals,
    estimated_cost_usd: cost,
    all_models_unpriced: r.all_models_unpriced === true,
    by_model: byModel,
  };
}

export function formatUsagePeriod(p: UsagePeriodReport): string {
  const t = p.totals;
  // `rig usage` emits estimated_cost_usd: 0.0 *together with* all_models_unpriced: true
  // when the only activity in this period is on a model with no known price — check the
  // flag first, or an unpriced period renders as a real "~$0.00" instead of "unpriced".
  const cost = p.all_models_unpriced || p.estimated_cost_usd === null ? 'n/a (unpriced model)' : `~$${p.estimated_cost_usd.toFixed(2)}`;
  const lines = [
    `${p.period} ${p.label}: ${formatTokenCount(t.total_tokens)} tokens, ${cost}`,
    `  in ${formatTokenCount(t.input_tokens)} · out ${formatTokenCount(t.output_tokens)} · cache-write ${formatTokenCount(t.cache_creation_input_tokens)} · cache-read ${formatTokenCount(t.cache_read_input_tokens)}`,
  ];
  const models = Object.entries(p.by_model)
    .filter(([name, m]) => name !== '<synthetic>' && m.totals.total_tokens > 0)
    .sort((a, b) => (b[1].estimated_cost_usd ?? 0) - (a[1].estimated_cost_usd ?? 0))
    .slice(0, 5);
  if (models.length > 0) {
    const byModel = models
      .map(([name, m]) => `${name} ${m.estimated_cost_usd === null ? 'n/a' : `$${m.estimated_cost_usd.toFixed(2)}`}`)
      .join(', ');
    lines.push(`  top models: ${byModel}`);
  }
  return lines.join('\n');
}

// The /spend reply body from `rig usage --json`'s raw stdout. `ok: false` carries the
// user-facing explanation and tells a scheduled caller NOT to treat the text as a report.
export function renderUsageReport(stdout: string): { ok: boolean; text: string } {
  let parsed: { disclaimer?: unknown; periods?: unknown };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, text: "spend: couldn't parse `rig usage --json` output (unexpected shape) — the command may have changed." };
  }
  const rawPeriods =
    parsed && parsed.periods && typeof parsed.periods === 'object' ? Object.values(parsed.periods as Record<string, unknown>) : [];
  const periods = rawPeriods.map(normalizeUsagePeriodReport).filter((p): p is UsagePeriodReport => p !== null);
  if (periods.length === 0) {
    return { ok: false, text: "spend: couldn't parse `rig usage --json` output (no period data) — the command may have changed." };
  }
  const disclaimer = typeof parsed.disclaimer === 'string' ? parsed.disclaimer : null;
  const body = periods.map(formatUsagePeriod).join('\n\n');
  return { ok: true, text: disclaimer ? `${body}\n\n${disclaimer}` : body };
}

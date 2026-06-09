import { expect, test } from 'bun:test';
import { planLineSpecs, type GateItem } from '../features/auto-attach/line-spec';
import { buildSendPlan, type ParsedItem } from '../features/auto-attach/normalize';

// In-memory reader factory: maps path → content. Unknown paths read as null
// (missing/binary/unreadable).
function reader(files: Record<string, string>) {
  return (p: string): string | null => (p in files ? files[p] : null);
}

const lineSpec = (token: string, n: number) => ({ token, startLine: n, endLine: n, col: undefined });

// A small (<=1024) line-spec file: snippet inline, NO attachment.
test('FIX 1 (a): line-spec file <=1024 → snippet inline + 0 attachments', () => {
  const content = ['const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', 'const e = 5'].join('\n');
  expect(content.length).toBeLessThanOrEqual(1024);
  const items: GateItem[] = [{ type: 'document', path: '/x.ts', auto: true, lineSpec: lineSpec('/x.ts:3', 3) }];
  const plan = planLineSpecs(items, reader({ '/x.ts': content }));
  // Snippet is always shown for a line-spec.
  expect(plan.quotes.length).toBe(1);
  expect(plan.quotes[0].token).toBe('/x.ts:3');
  expect(plan.quotes[0].quote).toContain('const c = 3');
  // But the small file is NOT attached (dropped) and NOT marker-copied.
  expect(plan.marked.length).toBe(0);
  expect(plan.dropped.has('/x.ts')).toBe(true);
});

// A large (>1024) line-spec file: snippet inline + 1 marker-injected attachment.
test('FIX 1 (a): line-spec file >1024 → snippet inline + 1 attachment with markers', () => {
  const big = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}`).join('\n');
  expect(big.length).toBeGreaterThan(1024);
  const items: GateItem[] = [{ type: 'document', path: '/big.ts', auto: true, lineSpec: lineSpec('/big.ts:50', 50) }];
  const plan = planLineSpecs(items, reader({ '/big.ts': big }));
  expect(plan.quotes.length).toBe(1);
  // Attached as a marker-injected copy, NOT dropped.
  expect(plan.dropped.has('/big.ts')).toBe(false);
  expect(plan.marked.length).toBe(1);
  expect(plan.marked[0].path).toBe('/big.ts');
  expect(plan.marked[0].filename).toBe('big.ts');
  // The marker band is present around the referenced range.
  expect(plan.marked[0].content).toContain('// line: ');
  expect(plan.marked[0].content).toContain('const v49 = 49');
});

// An EXPLICIT --file with an adopted line-spec (no `auto`) ≤1024 must still
// attach (with markers) — explicit flags are never gated.
test('FIX 1: explicit (non-auto) line-spec file <=1024 → snippet + attached with markers', () => {
  const content = ['a = 1', 'b = 2', 'c = 3', 'd = 4'].join('\n');
  const items: GateItem[] = [
    { type: 'document', path: '/e.ts', lineSpec: lineSpec('/e.ts:2', 2) }, // no auto
  ];
  const plan = planLineSpecs(items, reader({ '/e.ts': content }));
  expect(plan.quotes.length).toBe(1);
  // Explicit → attached despite being small.
  expect(plan.dropped.has('/e.ts')).toBe(false);
  expect(plan.marked.length).toBe(1);
  expect(plan.marked[0].content).toContain('// line: ');
});

// Bare (no line-spec), auto, <=1024 → 0 attachments, no snippet (token stays in
// text by the caller; this layer just drops the attachment).
test('FIX 1 (c): bare auto document <=1024 → dropped, no snippet, no marker', () => {
  const content = 'small file\njust two lines';
  const items: GateItem[] = [{ type: 'document', path: '/s.txt', auto: true }];
  const plan = planLineSpecs(items, reader({ '/s.txt': content }));
  expect(plan.quotes.length).toBe(0);
  expect(plan.marked.length).toBe(0);
  expect(plan.dropped.has('/s.txt')).toBe(true);
});

test('FIX 1: bare auto document >1024 → attached (not dropped)', () => {
  const big = 'x'.repeat(2000);
  const items: GateItem[] = [{ type: 'document', path: '/b.txt', auto: true }];
  const plan = planLineSpecs(items, reader({ '/b.txt': big }));
  expect(plan.dropped.has('/b.txt')).toBe(false);
});

test('FIX 1: EXPLICIT (non-auto) document <=1024 is NEVER gated — always attached', () => {
  const items: GateItem[] = [{ type: 'document', path: '/e.txt' }]; // no auto flag
  const plan = planLineSpecs(items, reader({ '/e.txt': 'tiny' }));
  expect(plan.dropped.size).toBe(0);
});

test('FIX 1: PHOTOS are never gated and never snippeted', () => {
  // Even a tiny "content" reader value is irrelevant for a photo.
  const items: GateItem[] = [{ type: 'photo', path: '/a.png', auto: true }];
  const plan = planLineSpecs(items, reader({ '/a.png': 'PNGDATA' }));
  expect(plan.dropped.size).toBe(0);
  expect(plan.quotes.length).toBe(0);
  expect(plan.marked.length).toBe(0);
});

test('FIX 1: binary-ext line-spec (report.pdf:12) → no snippet, no gate, attached as-is', () => {
  const items: GateItem[] = [
    { type: 'document', path: '/report.pdf', auto: true, lineSpec: lineSpec('/report.pdf:12', 12) },
  ];
  // reader returns null for a pdf (binary).
  const plan = planLineSpecs(items, reader({}));
  expect(plan.quotes.length).toBe(0);
  expect(plan.dropped.size).toBe(0);
  expect(plan.marked.length).toBe(0);
});

test('FIX 1: unreadable auto document is NOT dropped (err toward attaching)', () => {
  const items: GateItem[] = [{ type: 'document', path: '/gone.txt', auto: true }];
  const plan = planLineSpecs(items, reader({})); // reads null
  expect(plan.dropped.size).toBe(0);
});

test('FIX 1: custom limit is honored', () => {
  const items: GateItem[] = [{ type: 'document', path: '/m.txt', auto: true }];
  // 50 chars, limit 40 → >limit → attached.
  const plan = planLineSpecs(items, reader({ '/m.txt': 'x'.repeat(50) }), 40);
  expect(plan.dropped.has('/m.txt')).toBe(false);
  // 30 chars, limit 40 → <=limit → dropped.
  const plan2 = planLineSpecs(items, reader({ '/m.txt': 'x'.repeat(30) }), 40);
  expect(plan2.dropped.has('/m.txt')).toBe(true);
});

// --- Wiring integration (replicates the 3 load-bearing lines in `tg`) ---
// The send path: planLineSpecs → exclude dropped docs from R2 fileContents →
// buildSendPlan → drop-filter plan.documents. This guards the FIX 1 codex-2
// regression (R2 stripping a paste while the gate drops the only attachment).
test('FIX 1 wiring: small auto doc with pasted content → doc dropped AND paste survives', () => {
  const content = 'export const a = 1\nexport const b = 2';
  const path = '/small.ts';
  const text = `Updated:\n${content}\nthanks`;
  const items: GateItem[] = [{ type: 'document', path, auto: true }];

  // 1. plan the gate.
  const lsPlan = planLineSpecs(items, reader({ [path]: content }));
  expect(lsPlan.dropped.has(path)).toBe(true); // small → gated out

  // 2. exclude gated-out docs from R2 fileContents (the FIX 1 finding-2 fix).
  const fileContents = items
    .filter((it) => it.type === 'document' && !lsPlan.dropped.has(it.path))
    .map((it) => ({ path: it.path, content }));
  expect(fileContents.length).toBe(0); // the small doc is NOT fed to R2

  // 3. build + drop-filter (the FIX 1 wiring in tg).
  const parsed: ParsedItem[] = items.map((it) => ({ type: it.type, path: it.path }));
  const plan = buildSendPlan(parsed, text, 'plain', { fileContents });
  plan.documents = plan.documents.filter((d) => !(d.source.kind === 'disk' && lsPlan.dropped.has(d.source.path)));

  // The attachment is gone...
  expect(plan.documents.length).toBe(0);
  // ...and the pasted content STILL rides in the text (R2 did not strip it).
  expect(plan.textMessages[0].text).toContain('export const b = 2');
});

// Contrast: when the doc is NOT gated (large), R2 still strips a verbatim paste.
test('FIX 1 wiring: large auto doc → R2 strips the paste, doc attached', () => {
  const content = 'L\n'.repeat(700); // > 1024
  const path = '/big.ts';
  const text = `Here:\n${content}\nend`;
  const items: GateItem[] = [{ type: 'document', path, auto: true }];

  const lsPlan = planLineSpecs(items, reader({ [path]: content }));
  expect(lsPlan.dropped.has(path)).toBe(false);

  const fileContents = items
    .filter((it) => it.type === 'document' && !lsPlan.dropped.has(it.path))
    .map((it) => ({ path: it.path, content }));
  expect(fileContents.length).toBe(1);

  const parsed: ParsedItem[] = items.map((it) => ({ type: it.type, path: it.path }));
  const plan = buildSendPlan(parsed, text, 'plain', { fileContents });
  plan.documents = plan.documents.filter((d) => !(d.source.kind === 'disk' && lsPlan.dropped.has(d.source.path)));

  // Doc stays attached, and the verbatim paste is stripped (R2) since it's not gated.
  expect(plan.documents.length).toBe(1);
  expect(plan.textMessages[0].text).not.toContain('L\nL\nL');
});

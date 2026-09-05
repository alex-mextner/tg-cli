#!/usr/bin/env bun
// agents-hooks/v1 pre-send-text hook — the escalation-format gate.
//
// REFERENCE executable for the `escalation-format-gate` descriptor (the
// TEMPLATE next to this file, escalation-format-gate.pre-send-text.json).
// Vendored here (not installed anywhere by tg-cli itself) so the pre-send-text
// hook framework has a runnable, testable counterpart for the contract; a
// future installer (the agent-tools skill — a SEPARATE PR, see AGENTS.md /
// the ticket for this feature) is what actually copies/points a descriptor
// under ~/.agents/hooks/tg/ at this file.
//
// WARN MODE ONLY (CTO-approved design, 2026-07): this hook NEVER blocks. For
// --tag decision it checks whether the message body already
// contains a literal table (the standard escalation form: options / tradeoffs
// / recommendation, so the recipient can answer without re-deriving the
// question) and, if not, prints an actionable, copy-pasteable recommendation
// to stderr — but always allows the send. A harder, cheap "obviously no table
// anywhere" check already runs at PARSE TIME (features/cli/args.ts's
// TAG_GATES, Tier 1) and DOES block; this hook is Tier 2 — it sees the FINAL
// assembled body (post render/autolink) and is deliberately advisory because
// it can be wrong about subtler cases.
//
// TODO(flip-to-blocking, separate PR): once this gate's false-positive rate
// is known to be low, it may gain a `decision:"block"` / exit 10 path (with a
// RIG_HATCH_REQUEST-style bypass for a genuinely urgent send pending live
// approval — the "bypass may wait up to 15 min" language in this hook's
// message already describes THAT future state, not today's).
//
// Contract (agents-hooks/v1):
//   - stdin: a JSON event
//       {tool:"tg", point:"pre-send-text", args:{body, tag, chat_id}, ...}
//   - stdout: protocol JSON only -> {"hook_api":"agents-hooks/v1","decision":"allow",
//       "gate_tag":...,"gate_missing":...,"gate_table_kind":...,"gate_bypass":...,
//       "body_sha256":...,"gate_version":...}
//   - stderr: human-readable warning (the runner surfaces it unconditionally,
//       whether or not the hook errors — see runner.ts)
//   - exit code: ALWAYS 0 in this version (warn mode). A non-decision
//     tag, or a body that already has a table, is a silent allow (no stderr).

import { createHash } from 'crypto';
import { detectTableKind } from '../../render/table';
import { isEscalationTag } from '../../render/tag';
import { HOOK_API, type HookEvent, type HookOutput } from '../types';

const GATE_VERSION = '1';
// gate_bypass (HookOutput) is intentionally NEVER emitted by this version —
// reserved for the future block-mode + RIG_HATCH_REQUEST-style bypass path
// (see the TODO above); there is nothing to bypass while every send is
// already allowed.

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c as Buffer));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function emit(out: HookOutput): void {
  process.stdout.write(JSON.stringify({ hook_api: HOOK_API, ...out }));
}

async function main(): Promise<number> {
  const raw = await readStdin();
  let event: HookEvent;
  try {
    event = JSON.parse(raw) as HookEvent;
  } catch {
    // Malformed stdin is a hook ERROR (the runner applies on_error, 'open' by
    // default for this gate → allow + warn). Emit nothing parseable.
    process.stderr.write('escalation-format-gate: could not parse the hook event JSON\n');
    return 1;
  }

  // Assumed already lowercase-canonical: the `tg` CLI normalizes --tag before
  // it ever reaches run-text-hooks.ts (features/render/tag.ts's validateTag +
  // parseArgs's `.trim()`), so this is a case-sensitive membership check by
  // design, not an oversight. A programmatic caller of the hook framework
  // that skips that normalization (e.g. a hand-built HookEvent with tag:
  // "Decision") would silently not be gated here.
  const tag = typeof event.args?.tag === 'string' ? event.args.tag : '';
  const body = typeof event.args?.body === 'string' ? event.args.body : '';
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');

  if (!isEscalationTag(tag)) {
    // Not an escalation tag — nothing for this gate to check.
    emit({ decision: 'allow', gate_version: GATE_VERSION });
    return 0;
  }

  const kind = detectTableKind(body);
  if (kind !== 'none') {
    emit({
      decision: 'allow',
      gate_tag: tag,
      gate_missing: '',
      gate_table_kind: kind,
      body_sha256: bodySha256,
      gate_version: GATE_VERSION,
    });
    return 0;
  }

  // No literal table found — WARN (never block). The message is
  // self-contained: it carries the copy-pasteable table rows to fill in, not
  // just a link, so the recipient of the warning can act on it directly.
  const warning =
    `escalation-format-gate: --tag ${tag} sends work best as a literal table (the escalation ` +
    `form: options / tradeoffs / recommendation), so the recipient can answer without ` +
    `re-deriving the question. This send is proceeding (advisory only, does not block). ` +
    `Fill in a table next time, e.g.:\n` +
    `| Option | Tradeoff | Recommendation |\n` +
    `| --- | --- | --- |\n` +
    `| A | ... | ... |\n` +
    `| B | ... | ... |\n` +
    `A future version of this gate may block instead of warn; a genuine bypass may then ` +
    `wait up to 15 min for live approval.`;
  process.stderr.write(warning + '\n');
  emit({
    decision: 'allow',
    gate_tag: tag,
    gate_missing: 'table',
    gate_table_kind: kind,
    body_sha256: bodySha256,
    gate_version: GATE_VERSION,
  });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`escalation-format-gate: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });

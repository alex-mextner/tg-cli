// agents-hooks/v1 runner — PURE orchestration, all I/O injected.
//
// Mirrors the feature-flags design: the decision/ordering/trust/fail-open logic
// here is side-effect-free and unit-testable with no disk or subprocess; the
// real filesystem + Bun.spawnSync wiring lives in run-photo-hooks.ts.
//
// The non-breaking guarantee is enforced ONE level up (a single `stat` of
// ~/.agents/hooks/<tool>/ before this runner is ever called). If that dir is
// absent, runHooks is never invoked and the send path is byte-identical to
// today. This module only runs when descriptors exist.

import { isAbsolute } from 'path';
import {
  BLOCK_EXIT_CODE,
  DEFAULT_ON_ERROR,
  DEFAULT_PRIORITY,
  DEFAULT_TIMEOUT_MS,
  HOOK_API,
  invocationDigest,
  type Decision,
  type HookDescriptor,
  type HookEvent,
  type HookOutput,
  type HookRunResult,
  type HooksVerdict,
  type LoadedDescriptor,
  type OnError,
  type TrustState,
  type TrustStore,
} from './types';

// The raw result of spawning a hook subprocess. exitCode null = timeout/kill or
// spawn failure (treated as an error, never as a block).
export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// One audit line (append-only). Shape is deliberately flat for jsonl grepping.
export interface AuditLine {
  ts: string;
  event_id: string;
  tool: string;
  hook_id: string;
  point: string;
  cmd_sha256: string;
  decision: Decision | 'quarantined' | 'error';
  duration_ms: number;
  on_error_applied: OnError;
  trust_state: TrustState;
}

// Everything the pure runner needs from the outside world.
export interface RunnerDeps {
  // Trust pins (already parsed). Keyed by `${id}.${point}`. Only consulted when
  // `untrustedGuard` is on; ignored entirely in the trust-by-default common path.
  trust: TrustStore;
  // true → AGENTS_HOOKS_TRUST=1: the opt-in, off-by-default untrusted-input guard.
  // When set, the legacy TOFU quarantine + sha-pin re-engages (the paranoid case).
  // When UNSET (the default) every loaded descriptor is trusted and runs.
  untrustedGuard: boolean;
  // true → AGENTS_HOOKS_TRUST=auto: under the guard, pins are bypassed (the
  // batch/agent escape hatch). No effect when the guard is off (already trusted).
  trustAuto: boolean;
  // sha256 hex of a file's bytes; null if the file can't be read (missing cmd).
  sha256: (path: string) => string | null;
  // sha256 hex of an arbitrary string (used for the invocation digest).
  sha256Str: (s: string) => string;
  // Spawn the hook executable, write `stdinJson` to its stdin, enforce timeout.
  spawn: (cmd: string, args: string[], stdinJson: string, timeoutMs: number) => SpawnResult;
  // Append one audit line (best-effort; an audit failure must not break a send).
  audit: (line: AuditLine) => void;
  // Emit a human warning/banner (stderr). Never throws.
  warn: (msg: string) => void;
  // Monotonic-ish wall clock for durations.
  now: () => number;
  // ISO timestamp for audit lines.
  isoNow: () => string;
}

// Order descriptors: ascending priority, tie-break by descriptor filename.
export function orderDescriptors(loaded: LoadedDescriptor[]): LoadedDescriptor[] {
  return [...loaded].sort((a, b) => {
    const pa = a.descriptor.priority ?? DEFAULT_PRIORITY;
    const pb = b.descriptor.priority ?? DEFAULT_PRIORITY;
    if (pa !== pb) return pa - pb;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
}

// Resolve the trust state of a descriptor.
//
// DEFAULT (guard off) = TRUST-BY-DEFAULT: any descriptor whose executable exists
// is trusted and runs, with NO pin and NO quarantine. This is the common case —
// the user's own machine.
//
// Under the opt-in AGENTS_HOOKS_TRUST=1 guard the legacy TOFU re-engages: a
// descriptor is INERT (quarantined, treated as absent) unless its executable's
// current sha matches a pin — or trustAuto (AGENTS_HOOKS_TRUST=auto) is on. A
// changed executable re-quarantines.
export function resolveTrust(
  d: HookDescriptor,
  currentSha: string | null,
  currentInvocationSha: string,
  deps: Pick<RunnerDeps, 'trust' | 'trustAuto' | 'untrustedGuard'>,
): { state: TrustState; pinnedOnError?: OnError } {
  // A missing executable means there is nothing to run, guard or not.
  if (currentSha === null) return { state: 'untrusted-missing-cmd' };
  // Trust-by-default: the guard is off, so skip the pin machinery entirely.
  if (!deps.untrustedGuard) return { state: 'trusted-default' };
  // --- Guarded (paranoid) path: legacy TOFU quarantine + sha-pin. -----------
  if (deps.trustAuto) return { state: 'auto' };
  const pin = deps.trust[`${d.id}.${d.point}`];
  if (!pin) return { state: 'quarantined-new' };
  if (pin.cmd_sha256 !== currentSha) return { state: 'quarantined-changed' };
  // The invocation (cmd + args) must match too — a pin without invocation_sha256
  // predates this check and is treated as stale (re-trust required). This is
  // what stops a trusted interpreter `cmd` from being repointed via `args`.
  if (pin.invocation_sha256 !== currentInvocationSha) return { state: 'quarantined-changed' };
  return { state: 'trusted', pinnedOnError: pin.on_error };
}

// Map a subprocess result + on_error policy to a resolved decision.
// Block iff exit 10 (canonical). Any other non-zero / timeout / null is an
// ERROR; under on_error 'open' → allow+warn, under 'closed' → block.
function resolveDecision(
  spawn: SpawnResult,
  onError: OnError,
): { decision: Decision; errored: boolean; message?: string } {
  const parsed = parseOutput(spawn.stdout);
  const out = parsed.value;
  if (spawn.exitCode === BLOCK_EXIT_CODE) {
    // Canonical block — un-corruptible. exit 10 ALWAYS blocks, even if stdout is
    // malformed; the message falls back to a default when it can't be parsed.
    return {
      decision: 'block',
      errored: false,
      message: out.message ?? 'blocked by hook',
    };
  }
  if (spawn.exitCode === 0 && !spawn.timedOut) {
    // A clean exit with MALFORMED stdout is a protocol violation → hook ERROR,
    // subject to on_error. Otherwise a fail-closed gate that exits 0 but logs to
    // stdout (corrupting the protocol) would be silently allowed. Empty stdout is
    // valid (no extra fields) and means "allow".
    if (parsed.malformed) {
      return applyOnError(onError, 'hook produced malformed stdout (not agents-hooks/v1 JSON)');
    }
    // Honour an explicit stdout decision:"block" too (belt & suspenders for the
    // DX camp), but exit-10 remains the primary block path.
    if (out.decision === 'block') {
      return { decision: 'block', errored: false, message: out.message ?? 'blocked by hook' };
    }
    // An UNRECOGNIZED decision (a typo like "deny"/"blocked") is a protocol
    // violation, not an implicit allow — otherwise a broken fail-closed gate that
    // meant to block would be silently bypassed. Only "allow" or an absent
    // decision (empty/no field) count as a clean allow.
    if (out.decision !== undefined && out.decision !== 'allow') {
      return applyOnError(onError, `hook returned an unknown decision: ${JSON.stringify(out.decision)}`);
    }
    return { decision: 'allow', errored: false };
  }
  // Anything else (crash, kill, timeout) is a hook ERROR.
  const reason = spawn.timedOut
    ? 'hook timed out'
    : `hook exited ${spawn.exitCode === null ? 'abnormally' : spawn.exitCode}`;
  return applyOnError(onError, out.message ?? reason, reason);
}

// Map a hook error to a decision per on_error: 'open' → allow+warn, 'closed' →
// block. `warnReason` is the always-technical reason surfaced in the warning.
function applyOnError(
  onError: OnError,
  message: string,
  warnReason?: string,
): { decision: Decision; errored: boolean; message?: string } {
  if (onError === 'closed') {
    return { decision: 'block', errored: true, message };
  }
  return { decision: 'allow', errored: true, message: warnReason ?? message };
}

// Parse a hook's stdout. `malformed` is true when stdout is NON-EMPTY but not a
// valid agents-hooks/v1 JSON object — that is a protocol violation (a hook
// error), distinct from empty stdout (a valid "allow with no extra fields").
function parseOutput(stdout: string): { value: HookOutput; malformed: boolean } {
  const trimmed = stdout.trim();
  if (!trimmed) return { value: {}, malformed: false };
  try {
    const parsedJson = JSON.parse(trimmed) as HookOutput;
    if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
      return { value: parsedJson, malformed: false };
    }
    return { value: {}, malformed: true };
  } catch {
    return { value: {}, malformed: true };
  }
}

// Run all descriptors for a point against one event. Returns the aggregate
// verdict (blocked + first block message) and per-hook results, and writes an
// audit line per hook. The FIRST block short-circuits remaining hooks.
export function runHooks(
  loaded: LoadedDescriptor[],
  buildEvent: (d: HookDescriptor) => HookEvent,
  deps: RunnerDeps,
): HooksVerdict {
  const ordered = orderDescriptors(loaded);
  const results: HookRunResult[] = [];
  let blocked = false;
  let blockMessage: string | undefined;

  for (const { descriptor: d } of ordered) {
    const currentSha = deps.sha256(d.cmd);
    const currentInvocationSha = deps.sha256Str(invocationDigest(d.cmd, d.args));
    const { state, pinnedOnError } = resolveTrust(d, currentSha, currentInvocationSha, deps);

    // One canonical event id per firing: the SAME id the hook sees on stdin is
    // the id written to audit.jsonl, so logs correlate. Built here (cheap) even
    // for quarantined descriptors so the audit line still has a stable id.
    const event = buildEvent(d);
    const eventId = event.event_id;

    // Quarantined / missing-cmd → treated as ABSENT (does NOT run, does NOT
    // block). A loud banner tells the user how to trust it. This is what keeps a
    // freshly-dropped gate from bricking the first send.
    if (state === 'quarantined-new' || state === 'quarantined-changed' || state === 'untrusted-missing-cmd') {
      const banner = bannerFor(state, d);
      deps.warn(banner);
      const result: HookRunResult = {
        hookId: d.id,
        point: d.point,
        cmdSha256: currentSha ?? '',
        decision: 'allow',
        rawExitCode: null,
        durationMs: 0,
        onErrorApplied: effectiveOnError(d, pinnedOnError),
        trustState: state,
        errored: false,
        quarantined: true,
      };
      results.push(result);
      auditOne(deps, eventId, d, result, 'quarantined');
      continue;
    }

    // Trusted (or auto) → actually run it.
    const onError = effectiveOnError(d, pinnedOnError);
    const timeoutMs = d.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const stdinJson = JSON.stringify(event);
    const start = deps.now();
    const spawn = deps.spawn(d.cmd, d.args ?? [], stdinJson, timeoutMs);
    const durationMs = deps.now() - start;

    const { decision, errored, message } = resolveDecision(spawn, onError);
    if (errored && message) deps.warn(`hook ${d.id}: ${message} (on_error=${onError})`);
    if (spawn.stderr.trim()) deps.warn(`hook ${d.id} stderr: ${spawn.stderr.trim()}`);

    const result: HookRunResult = {
      hookId: d.id,
      point: d.point,
      cmdSha256: currentSha,
      decision,
      rawExitCode: spawn.exitCode,
      message,
      durationMs,
      onErrorApplied: onError,
      trustState: state,
      errored,
      quarantined: false,
    };
    results.push(result);
    auditOne(deps, eventId, d, result, errored ? 'error' : decision);

    if (decision === 'block') {
      blocked = true;
      blockMessage = message;
      break; // first block short-circuits
    }
  }

  return { blocked, blockMessage, results };
}

function effectiveOnError(d: HookDescriptor, pinned?: OnError): OnError {
  // The TRUST PIN is authoritative; the descriptor only proposes.
  return pinned ?? d.on_error ?? DEFAULT_ON_ERROR;
}

function bannerFor(state: TrustState, d: HookDescriptor): string {
  // The quarantine states only arise under the AGENTS_HOOKS_TRUST=1 guard
  // (trust-by-default never quarantines), so the banners point at the guarded
  // activation path. 'untrusted-missing-cmd' can fire in either mode.
  if (state === 'quarantined-new') {
    return (
      `NEW HOOK (not active under AGENTS_HOOKS_TRUST=1): ${d.id} → ${d.point}. ` +
      `Run 'tg hooks trust ${d.id}', set AGENTS_HOOKS_TRUST=auto, or unset the guard to activate it.`
    );
  }
  if (state === 'quarantined-changed') {
    return (
      `HOOK CHANGED (not active under AGENTS_HOOKS_TRUST=1): ${d.id} → ${d.point} executable changed since trust. ` +
      `Re-trust with 'tg hooks trust ${d.id}'.`
    );
  }
  return `HOOK SKIPPED: ${d.id} → ${d.point} points at a missing executable (${d.cmd}).`;
}

function auditOne(
  deps: RunnerDeps,
  eventId: string,
  d: HookDescriptor,
  r: HookRunResult,
  decision: AuditLine['decision'],
): void {
  try {
    deps.audit({
      ts: deps.isoNow(),
      event_id: eventId,
      tool: 'tg',
      hook_id: d.id,
      point: d.point,
      cmd_sha256: r.cmdSha256,
      decision,
      duration_ms: r.durationMs,
      on_error_applied: r.onErrorApplied,
      trust_state: r.trustState,
    });
  } catch {
    // An audit failure must never break a send.
  }
}

// id / point must be safe tokens: they end up inside copy-pastable shell
// banners (`Run 'tg hooks trust <id>'`) and as trust-store keys, so a quoted /
// metacharacter-laden id from an untrusted drop-in must be rejected, not
// rendered raw. Conservative: alphanumerics, dash, underscore, dot.
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

// Validate a parsed descriptor object. Returns a reason on a bad shape, so a
// corrupt / hostile drop-in kills ONLY that hook (never throws into the send
// path). Descriptors are UNTRUSTED TOFU input — validate defensively.
export function validateDescriptor(
  obj: unknown,
): { ok: true; descriptor: HookDescriptor } | { ok: false; reason: string } {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not an object' };
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return { ok: false, reason: 'missing id' };
  if (!SAFE_TOKEN.test(o.id)) return { ok: false, reason: 'id has unsafe characters' };
  if (typeof o.point !== 'string' || !o.point) return { ok: false, reason: 'missing point' };
  if (!SAFE_TOKEN.test(o.point)) return { ok: false, reason: 'point has unsafe characters' };
  if (typeof o.cmd !== 'string' || !o.cmd) return { ok: false, reason: 'missing cmd' };
  // cmd MUST be absolute: the runner hashes d.cmd via readFileSync (cwd-relative)
  // but spawns via Bun.spawnSync which resolves a bare name through PATH — so a
  // relative/bare cmd lets the pinned bytes differ from the executed bytes.
  if (!isAbsolute(o.cmd)) return { ok: false, reason: 'cmd must be an absolute path' };
  if (o.args !== undefined && !Array.isArray(o.args)) return { ok: false, reason: 'args not array' };
  if (Array.isArray(o.args) && !o.args.every((a) => typeof a === 'string')) {
    return { ok: false, reason: 'args must be strings' };
  }
  if (o.on_error !== undefined && o.on_error !== 'open' && o.on_error !== 'closed') {
    return { ok: false, reason: 'on_error not open|closed' };
  }
  const descriptor: HookDescriptor = {
    id: o.id,
    point: o.point,
    cmd: o.cmd,
    args: Array.isArray(o.args) ? (o.args as string[]) : undefined,
    priority: typeof o.priority === 'number' ? o.priority : undefined,
    timeout_ms: typeof o.timeout_ms === 'number' ? o.timeout_ms : undefined,
    on_error: o.on_error as OnError | undefined,
    description: typeof o.description === 'string' ? o.description : undefined,
  };
  return { ok: true, descriptor };
}

// Re-export the contract id so the seam can stamp events without importing types.
export { HOOK_API };

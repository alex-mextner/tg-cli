// `tg hooks ...` subcommand — the TOFU activation path the quarantine banners
// point users at. Without this, "Run 'tg hooks trust <id>'" is a lie and the
// only way to activate a hook is hand-editing trust.json or AGENTS_HOOKS_TRUST=auto.
//
// The pure logic (compute the new trust store from a descriptor + current sha)
// lives in computeTrustPin / formatList so it is unit-testable with no disk; the
// disk wiring is runHooksCli.

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { validateDescriptor } from './runner';
import { toolHooksDir, trustFile } from './run-photo-hooks';
import { DEFAULT_ON_ERROR, invocationDigest, type HookDescriptor, type TrustPin, type TrustStore } from './types';

export interface HooksCliDeps {
  readDir: (dir: string) => string[];
  readFile: (path: string) => string;
  writeTrust: (store: TrustStore) => void;
  sha256: (path: string) => string | null;
  sha256Str: (s: string) => string;
  log: (msg: string) => void;
  errlog: (msg: string) => void;
}

// Load+validate every descriptor for the tg tool. A bad drop-in is skipped.
export function loadAllDescriptors(
  deps: Pick<HooksCliDeps, 'readDir' | 'readFile'>,
  dir: string,
): { descriptor: HookDescriptor; file: string }[] {
  let files: string[];
  try {
    files = deps.readDir(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: { descriptor: HookDescriptor; file: string }[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = deps.readFile(join(dir, f));
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const v = validateDescriptor(parsed);
    if (v.ok) out.push({ descriptor: v.descriptor, file: f });
  }
  return out;
}

// The pure pin computation: pin the executable bytes AND the invocation digest
// (cmd + args), so neither a swapped binary nor a repointed `args` survives
// re-trust. on_error in the pin is authoritative; we take the descriptor's
// proposal (default 'open') unless an override is given.
export function computeTrustPin(
  d: HookDescriptor,
  currentSha: string,
  invocationSha: string,
  override?: TrustPin['on_error'],
): { key: string; pin: TrustPin } {
  return {
    key: `${d.id}.${d.point}`,
    pin: {
      cmd_sha256: currentSha,
      invocation_sha256: invocationSha,
      point: d.point,
      on_error: override ?? d.on_error ?? DEFAULT_ON_ERROR,
    },
  };
}

// Render a `hooks list` table line for one descriptor.
export function formatList(
  descriptors: { descriptor: HookDescriptor; file: string }[],
  trust: TrustStore,
  sha256: (path: string) => string | null,
  sha256Str: (s: string) => string,
): string {
  if (descriptors.length === 0) return 'No tg hooks installed (~/.agents/hooks/tg/ is empty).';
  const lines = ['tg hooks:'];
  for (const { descriptor: d } of descriptors) {
    const sha = sha256(d.cmd);
    const invSha = sha256Str(invocationDigest(d.cmd, d.args));
    const pin = trust[`${d.id}.${d.point}`];
    let status: string;
    if (sha === null) status = 'MISSING-CMD';
    else if (!pin) status = 'untrusted (quarantined)';
    else if (pin.cmd_sha256 !== sha || pin.invocation_sha256 !== invSha) status = 'CHANGED (re-trust)';
    else status = `trusted (on_error=${pin.on_error})`;
    lines.push(`  ${d.id} → ${d.point}  [${status}]  ${d.cmd}`);
  }
  return lines.join('\n');
}

// --- subcommand handlers (pure-ish: I/O via deps) --------------------------

export function cmdList(deps: HooksCliDeps, home: string): number {
  const dir = toolHooksDir(home);
  const descriptors = loadAllDescriptors(deps, dir);
  const trust = readTrust(deps, home);
  deps.log(formatList(descriptors, trust, deps.sha256, deps.sha256Str));
  return 0;
}

export function cmdTrust(deps: HooksCliDeps, home: string, id: string, override?: TrustPin['on_error']): number {
  const dir = toolHooksDir(home);
  const descriptors = loadAllDescriptors(deps, dir);
  const match = descriptors.filter((x) => x.descriptor.id === id);
  if (match.length === 0) {
    deps.errlog(`No tg hook with id '${id}' in ${dir}.`);
    return 1;
  }
  const trust = readTrust(deps, home);
  let pinned = 0;
  for (const { descriptor: d } of match) {
    const sha = deps.sha256(d.cmd);
    if (sha === null) {
      deps.errlog(`Hook '${d.id}' → ${d.point} points at a missing executable (${d.cmd}); not pinned.`);
      continue;
    }
    const invSha = deps.sha256Str(invocationDigest(d.cmd, d.args));
    const { key, pin } = computeTrustPin(d, sha, invSha, override);
    trust[key] = pin;
    deps.log(`Trusted ${d.id} → ${d.point} (on_error=${pin.on_error}).`);
    pinned += 1;
  }
  if (pinned === 0) return 1;
  deps.writeTrust(trust);
  return 0;
}

export function cmdUntrust(deps: HooksCliDeps, home: string, id: string): number {
  const trust = readTrust(deps, home);
  // EXACT id match. A key is `${id}.${point}`; since ids may contain dots, a
  // naive `startsWith(id + '.')` would also match e.g. `review.visual.<point>`
  // when untrusting `review`. Reconstruct the canonical key from each pin's own
  // `point` and compare to `${id}.${point}` exactly.
  const keys = Object.keys(trust).filter((k) => {
    const pin = trust[k];
    return pin?.point !== undefined && k === `${id}.${pin.point}`;
  });
  if (keys.length === 0) {
    deps.errlog(`No trust pin for hook id '${id}'.`);
    return 1;
  }
  for (const k of keys) delete trust[k];
  deps.writeTrust(trust);
  deps.log(`Removed trust pin(s) for ${id}.`);
  return 0;
}

function readTrust(deps: Pick<HooksCliDeps, 'readFile'>, home: string): TrustStore {
  try {
    const parsed = JSON.parse(deps.readFile(trustFile(home)));
    if (parsed && typeof parsed === 'object') return parsed as TrustStore;
    return {};
  } catch {
    return {};
  }
}

const HOOKS_USAGE = `Usage:
  tg hooks list                       list installed tg hooks + trust status
  tg hooks trust <id> [open|closed]   pin a hook's executable sha (TOFU activate)
  tg hooks untrust <id>               remove a hook's trust pin (re-quarantine)`;

// Parse + dispatch `tg hooks <sub> ...`. Returns an exit code, or null if argv
// is not a hooks subcommand (so the caller falls through to the send path).
export function runHooksCli(args: string[], home = homedir()): number | null {
  if (args[0] !== 'hooks') return null;
  const deps = realDeps(home);
  const sub = args[1];
  if (sub === 'list' || sub === undefined) return cmdList(deps, home);
  if (sub === 'trust') {
    const id = args[2];
    if (!id) {
      deps.errlog('Usage: tg hooks trust <id> [open|closed]');
      return 1;
    }
    // An invalid policy arg (e.g. "close" for "closed") must NOT be silently
    // ignored — this is the fail-open/closed activation path, so a typo pinning
    // the wrong policy is a security footgun. Reject it.
    let override: TrustPin['on_error'] | undefined;
    if (args[3] !== undefined) {
      if (args[3] !== 'open' && args[3] !== 'closed') {
        deps.errlog(`Invalid on_error '${args[3]}' — expected 'open' or 'closed'.`);
        return 1;
      }
      override = args[3];
    }
    return cmdTrust(deps, home, id, override);
  }
  if (sub === 'untrust') {
    const id = args[2];
    if (!id) {
      deps.errlog('Usage: tg hooks untrust <id>');
      return 1;
    }
    return cmdUntrust(deps, home, id);
  }
  deps.errlog(HOOKS_USAGE);
  return 2;
}

function realDeps(home: string): HooksCliDeps {
  return {
    readDir: (dir) => readdirSync(dir),
    readFile: (path) => readFileSync(path, 'utf8'),
    writeTrust: (store) => {
      const file = trustFile(home);
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(store, null, 2));
      try {
        chmodSync(file, 0o600); // trust.json holds security-relevant pins
      } catch {
        // best-effort
      }
    },
    sha256: (path) => {
      try {
        return createHash('sha256').update(readFileSync(path)).digest('hex');
      } catch {
        return null;
      }
    },
    sha256Str: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
    log: (msg) => console.log(msg),
    errlog: (msg) => console.error(msg),
  };
}

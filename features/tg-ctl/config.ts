// Control-channel config for tg-ctl (spec §9).
//
// Same philosophy as features/auto-attach/feature-flags.ts: the config file is
// a top-level `control:` block of one-level `  key: value` scalars, so a tiny
// hand-rolled reader beats a yaml dependency (package.json intentionally has
// only bun-types). Anything outside that exact shape is ignored.
//
// Everything here is PURE — the config.yaml file I/O lives in the tg-ctl
// entrypoint, which hands the already-read contents to parseControlConfig.

import { DEFAULT_CONTROL, type ControlConfig } from './types';

// Same boolean token sets as the features: block parser (they are module-
// private there; the contract is the values, not the Set instance).
const TRUE_TOKENS = new Set(['true', 'yes', 'on', '1']);
const FALSE_TOKENS = new Set(['false', 'no', 'off', '0']);

// 'channel' is reserved for v1.2+ but type-valid — resolve keeps it; the v1
// entrypoint decides what an unimplemented transport means.
const TRANSPORTS = new Set<string>(['auto', 'tmux', 'channel']);

const unquote = (s: string): string => s.replace(/^["']|["']$/g, '');

// Strict non-negative integer literal — Number() alone would accept '1e3',
// '0x10', '-5' and ''. Positivity is resolve's job, not the parser's.
const INT_RE = /^\d+$/;

export function parseControlConfig(yaml: string): Partial<ControlConfig> {
  const out: Partial<ControlConfig> = {};
  let inControl = false;
  for (const rawLine of yaml.split('\n')) {
    // Strip trailing comments (only when clearly a comment, not inside a value).
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      // A top-level key. We only care about `control:`.
      inControl = line.trim().replace(/:.*$/, '') === 'control';
      continue;
    }
    if (!inControl) continue;

    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = unquote(trimmed.slice(0, colon).trim());
    const value = trimmed.slice(colon + 1).trim();
    if (!value) continue;

    switch (key) {
      case 'enabled': {
        const v = value.toLowerCase();
        if (TRUE_TOKENS.has(v)) out.enabled = true;
        else if (FALSE_TOKENS.has(v)) out.enabled = false;
        // unrecognized value → ignore (don't guess)
        break;
      }
      case 'topics': {
        const v = value.toLowerCase();
        if (TRUE_TOKENS.has(v)) out.topics = true;
        else if (FALSE_TOKENS.has(v)) out.topics = false;
        // unrecognized value → ignore (don't guess)
        break;
      }
      case 'transport':
        // Raw string passthrough — resolveControlConfig normalizes garbage.
        out.transport = unquote(value) as ControlConfig['transport'];
        break;
      case 'session':
        out.session = unquote(value);
        break;
      case 'inject_wrap':
        out.injectWrap = unquote(value);
        break;
      case 'staleness_sec':
        if (INT_RE.test(value)) out.stalenessSec = Number(value);
        break;
      case 'idle_exit_min':
        if (INT_RE.test(value)) out.idleExitMin = Number(value);
        break;
      case 'allowed_senders':
        out.allowedSenders = unquote(value)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => INT_RE.test(s))
          .map(Number);
        break;
      // unknown key → ignore
    }
  }
  return out;
}

// Merge a parsed partial over the defaults, healing invalid values: a
// transport outside the union → 'auto'; staleness_sec / idle_exit_min must be
// positive integers or the default wins. Healing lives here (not in the
// parser) so programmatic callers get the same guarantees as config files.
export function resolveControlConfig(partial: Partial<ControlConfig>): ControlConfig {
  const posInt = (v: number | undefined, dflt: number): number =>
    v !== undefined && Number.isInteger(v) && v > 0 ? v : dflt;

  const cfg: ControlConfig = {
    enabled: partial.enabled ?? DEFAULT_CONTROL.enabled,
    transport:
      partial.transport !== undefined && TRANSPORTS.has(partial.transport)
        ? partial.transport
        : 'auto',
    injectWrap: partial.injectWrap ?? DEFAULT_CONTROL.injectWrap,
    stalenessSec: posInt(partial.stalenessSec, DEFAULT_CONTROL.stalenessSec),
    idleExitMin: posInt(partial.idleExitMin, DEFAULT_CONTROL.idleExitMin),
    // Copy — the resolved config must never alias DEFAULT_CONTROL's array.
    allowedSenders: [...(partial.allowedSenders ?? DEFAULT_CONTROL.allowedSenders)],
    topics: partial.topics ?? DEFAULT_CONTROL.topics,
  };
  if (partial.session !== undefined) cfg.session = partial.session;
  return cfg;
}

// Singleton/lifecycle helpers for tg-ctl (spec §6, §7).
//
// Everything here is PURE — the actual flock(2) (bun:ffi), kill(2) and file
// reads live in the tg-ctl entrypoint, which feeds these helpers plain data.
// `kill0` is injected so pidStatus is testable without sending real signals.

import { join } from 'path';
import type { ControlConfig, CtlPaths } from './types';

// All daemon state files are keyed by bot id so two bots on one machine never
// collide (the flock guarantees one poller PER TOKEN, not per machine).
export function ctlPaths(configDir: string, botId: string): CtlPaths {
  const base = `tg-ctl.${botId}`;
  return {
    lock: join(configDir, `${base}.lock`),
    pid: join(configDir, `${base}.pid`),
    offset: join(configDir, `${base}.offset`),
    registration: join(configDir, `${base}.registration.json`),
    socket: join(configDir, `${base}.sock`),
    log: join(configDir, `${base}.log`),
  };
}

// Bot tokens look like "123456:ABC-DEF…" — the numeric part is stable and safe
// to embed in filenames, the secret part never is. Anything malformed → ''
// (the caller treats that as "no usable token").
export function botIdFromToken(token: string): string {
  const colon = token.indexOf(':');
  if (colon <= 0) return '';
  const id = token.slice(0, colon);
  return /^\d+$/.test(id) ? id : '';
}

// Pidfile content → pid. Only positive integers qualify: pid 0 would signal
// the whole process group via kill(0, …), negatives target groups too.
export function readPidFile(content: string | null): number | null {
  if (content === null) return null;
  const trimmed = content.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return pid > 0 ? pid : null;
}

// The pidfile is purely informational (spec §6) — the flock is the real
// singleton. 'stale' means the file exists but kill -0 says the process died.
export function pidStatus(
  pid: number | null,
  kill0: (pid: number) => boolean,
): 'running' | 'stale' | 'absent' {
  if (pid === null) return 'absent';
  return kill0(pid) ? 'running' : 'stale';
}

// Lazy auto-start gate (spec §7): inside tmux AND control.enabled. Deliberately
// NO TTY check — agents call tg through a piped Bash tool, so isatty is false
// in exactly the scenario that must fire; the TMUX check alone excludes
// CI/cron. Fire-and-forget: the daemon's flock makes double-starts a no-op.
export function shouldAutoStart(env: { TMUX?: string }, cfg: ControlConfig): boolean {
  return Boolean(env.TMUX) && cfg.enabled;
}

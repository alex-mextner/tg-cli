# tg-ctl v1 — implementation plan

Source of truth: `docs/specs/2026-06-10-tg-ctl-control-design.md` (§16 scope; the
review corrections inline). Shared type contract: `features/tg-ctl/types.ts` —
modules import it, never redefine the shapes.

## Modules (parallel, no file overlap)

### 1. `features/tg-ctl/config.ts` + `tests/ctl-config.test.ts`
- `parseControlConfig(yaml: string): Partial<ControlConfig>` — hand-rolled
  parser for the top-level `control:` block, same style as
  `features/auto-attach/feature-flags.ts` (one nesting level, comments
  stripped, no yaml dep). Values: booleans (true/yes/on/1 …), ints, plain
  strings; `allowed_senders` = comma-separated ints. Key mapping:
  `enabled, transport, session, inject_wrap, staleness_sec, idle_exit_min,
  allowed_senders` → camelCase fields.
- `resolveControlConfig(partial: Partial<ControlConfig>): ControlConfig` —
  merge over `DEFAULT_CONTROL`; invalid transport → 'auto'; non-positive ints →
  defaults.

### 2. `features/tg-ctl/lock.ts` + `tests/ctl-lock.test.ts`
- `ctlPaths(configDir: string, botId: string): CtlPaths` — lock/pid/offset/
  registration/log paths (`tg-ctl.<botid>.*` under configDir).
- `botIdFromToken(token: string): string` — digits before `:`; empty token → ''.
- `readPidFile(content: string | null): number | null` (trim, NaN-safe).
- `pidStatus(pid: number | null, kill0: (pid: number) => boolean): 'running' | 'stale' | 'absent'`.
- `shouldAutoStart(env: {TMUX?: string}, cfg: ControlConfig): boolean` — TMUX
  set AND cfg.enabled. NO TTY check (spec §7).
- Pure only — the actual flock lives in the entrypoint (bun:ffi).

### 3. `features/tg-ctl/updates.ts` + `tests/ctl-updates.test.ts`
- `stepUpdates(updates: TgUpdate[], opts: { cfg: ControlConfig; chatId: number;
  nowSec: number }): StepResult` — the heart. Rules (spec §9, §10, §13):
  - allowlist: `message.from.id` must be `chatId` or in `cfg.allowedSenders`;
    rejected → no action, but offset still advances.
  - staleness: `nowSec - message.date > cfg.stalenessSec` → drop, count in
    `skippedStale` (caller sends ONE "skipped N stale messages" notice).
  - commands: text starting with `/`: `/stop` → inject-key Escape; `/kill` →
    kill-agent; `/status` → status; any other `/cmd …` → inject-text VERBATIM
    (passthrough, no wrap).
  - plain text → inject-text with `wrapInbound(cfg.injectWrap, name, text)`
    (import from inject.ts). Name = `from.first_name || from.username || 'tg'`.
  - photo (largest size) / document → download-media action with
    `suggestedName = <update_id>.<ext>` (photo → .jpg; document → sanitized ext
    from file_name, default .bin; NEVER the Telegram-supplied basename);
    `>20MB` (`file_size > 20*1024*1024`) → reply "file too large for Bot API
    (>20 MB)" instead.
  - `newOffset` = max(update_id) + 1; empty input → offset unchanged (pass
    `currentOffset` inside opts? No: empty updates → `newOffset = -1` sentinel?
    Use: empty → return `newOffset` equal to a passed `opts.currentOffset`).
    Decision: add `currentOffset: number` to opts; always
    `newOffset = updates.length ? maxId + 1 : opts.currentOffset`.
- Non-message updates (no `message` field) advance offset silently.

### 4. `features/tg-ctl/inject.ts` + `tests/ctl-inject.test.ts`
- `wrapInbound(template: string, name: string, msg: string): string` —
  `{name}`/`{msg}` substitution.
- `buildTextInjectPlan(paneId: string, text: string, opts?: { escapePrelude?:
  boolean; gapMs?: number }): InjectStep[]` — spec §5.2 (corrected):
  - starts with `{kind:'verify-pane'}`;
  - optional Escape prelude (`send-keys -t <pane> Escape`, sleep ~200ms);
  - single-line (no `\n`): `['tmux','send-keys','-t',paneId,'-l',text]`;
  - multi-line: `['tmux','load-buffer','-']` with `stdin: text`, then
    `['tmux','paste-buffer','-p','-d','-t',paneId]`;
  - `{kind:'sleep', ms: gapMs ?? 500}`;
  - `['tmux','send-keys','-t',paneId,'Enter']` — separate call, NEVER combined.
- `buildKeyInjectPlan(paneId: string, key: 'Escape'): InjectStep[]` —
  verify-pane + raw key (no `-l`).

### 5. `features/tg-ctl/discover.ts` + `tests/ctl-discover.test.ts`
- `parsePaneList(out: string): PaneInfo[]` — parse
  `#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}`
  (tab separator — paths may contain spaces).
- `parseProcList(out: string): ProcInfo[]` — parse `ps -axo pid=,ppid=,command=`.
- `findAgentInPane(pane: PaneInfo, procs: ProcInfo[]): {agent: AgentKind; pid?: number} | null`
  — BFS the descendants of `panePid`; match command basename/argv0:
  `claude` → claude (NOTE: cc's pane_current_command is its VERSION string, the
  real `claude` process is a CHILD of pane_pid — verified live); `opencode` /
  `opencode.exe`; `codex`; `aider`. Shells (`-zsh`, `bash` …) are traversed,
  not matched.
- `pickTargetPane(panes: PaneInfo[], procs: ProcInfo[], reg: Registration | null,
  fixedSession?: string): DiscoverResult` — priority: (1) registration paneId if
  that pane still hosts an agent; (2) `fixedSession` panes; (3) registration cwd
  match; (4) sole agent pane on the server; multiple remaining → `ambiguous`
  with candidates; none → `no-agent`.

## Entrypoint `tg-ctl` (repo root, after modules land)

Single file, `#!/usr/bin/env bun`, `import.meta.main` guard, exported helpers.
Subcommands:
- `start [--pane %N --cwd PATH --session NAME]` — write registration file
  (synchronously, even if daemon already runs), then spawn
  `[process.execPath, <self>, 'run']` with
  `{detached: true, stdio: ['ignore', logFd, logFd]}` + `unref()`, exit 0.
- `run` — daemon: (1) bun:ffi flock(LOCK_EX|LOCK_NB) on the lock path FIRST,
  exit 0 on failure; (2) write pidfile; (3) SIGTERM/SIGINT handler → clean
  pidfile, exit; (4) poll loop.
- `stop` — pidfile → SIGTERM → remove pidfile. `status` — human one-liner:
  running/stopped, pid, bot id, target pane (registration + live discovery),
  offset age.
- Poll loop: `GET ${TG_API_BASE}/bot<token>/getUpdates?timeout=50&offset=N&
  allowed_updates=["message"]` (fetch timeout 60s) → `stepUpdates` → persist
  offset file BEFORE executing actions (at-most-once, spec §10) → execute:
  - reply → sendMessage; status → compose + sendMessage;
  - download-media → getFile + fetch file → `~/.cache/tg-cli/inbound/<name>` →
    inject wrapped "[TG from {name}] sent {photo|file}: <path>{ — caption}".
  - inject-* → discovery (tmux list-panes + ps), verify, execute InjectSteps
    (spawnSync tmux; sleep via Bun.sleep); failure → sendMessage the §5.2
    no-tmux guard text.
  - kill-agent → SIGINT to discovered agentPid; reply "session killed —
    restore via `claude --resume`".
  - skippedStale > 0 → one "skipped N stale messages" sendMessage.
- 409 → backoff 1,2,4…60s; after 5 consecutive → one warning sendMessage/log
  line, keep idling. Other HTTP/network errors → log + 5s sleep.
- Idle TTL: track lastAgentSeen; no agent pane for `idleExitMin` → clean exit.
- `flock` via bun:ffi: try `libSystem.B.dylib`, fall back to `libc.so.6`.
  LOCK_EX|LOCK_NB = 6. Keep fd open forever.

## `tg` wiring (~20 lines)

After a successful send in main: `shouldAutoStart(process.env, controlCfg)` →
spawn `[join(import.meta.dir, 'tg-ctl'), 'start', '--pane', TMUX_PANE, '--cwd',
cwd]` detached/ignore/unref, swallow all errors. Read the `control:` block from
the same config.yaml read that already exists.

## Integration tests (after entrypoint)

- `tests/ctl-singleton-integration.test.ts` — spawn two `tg-ctl run` with
  `TG_CTL_CONFIG_DIR=tmpdir` + fake TG_API_BASE; assert one holds (stays
  alive), the other exits 0 quickly.
- `tests/ctl-daemon-integration.test.ts` — `Bun.serve` Bot-API fake
  (getUpdates queue, sendMessage capture, getFile); spawn daemon; assert:
  prompt update → tmux inject attempted (fake tmux via PATH shim script that
  logs argv) or no-tmux reply captured; /status → reply captured; stale update
  → skipped notice.
- `tests/ctl-tmux-integration.test.ts` — `test.skipIf(!tmuxAvailable)`:
  throwaway `tmux new -d -s tgctl-test-<pid>` running a Bun readline stub;
  inject single-line and 3-line messages via the real InjectStep executor;
  assert exactly one submission each via capture-pane; assert Escape verb.
  Always `kill-server`-clean the session in finally.

## Release

`VERSION = "1.4.0"` in `tg` + `## 1.4.0` CHANGELOG section. README: control
section + "one bot token per machine for inbound". `~/.files/bin/tg-ctl`
symlink only AFTER merge to main (live-symlink rule).

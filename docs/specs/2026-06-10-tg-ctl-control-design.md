# tg-ctl — Control Channel for tg-cli

- **Status:** Draft — awaiting review
- **Date:** 2026-06-10
- **Branch:** `feat/tg-ctl-control`

## 1. Concept & goals

`tg-cli` today is a one-shot outbound sender (agent → Telegram). This spec adds a
thin, **optional inbound control path** so you can talk back to a running agent
session from Telegram — without turning `tg-cli` into a remote-terminal mirror.

**Philosophy (the differentiator):** moderated, agent-curated signal. The agent
already decides what is worth sending out (it calls `tg "..."` deliberately).
Inbound = inject a message/question into the live session; the answer comes back
**only** as what the agent explicitly sends (via `tg`, or a channel reply). No
full-session mirror, no scraped firehose, no completion-detection heuristics.

**Goals:**
- Send a message from Telegram into a running, **normally-started** agent session.
- Get a curated answer back (agent calls `tg`, or replies via channel).
- Forward agent-initiated questions / permission prompts to Telegram, answerable
  with inline buttons.
- Two transports: **Channel (priority)** and **tmux (fallback + control verbs)**.
- Single daemon, strictly **singleton**, lazily auto-started by `tg`.

## 2. Non-goals (explicit)

- **No completion / Stop-hook detection** — CC Stop hooks false-fire; rejected by design.
- **No full-session streaming / terminal mirror** — that is `/rc` and every competitor.
- **No screen-scraping** (`capture-pane`) for the round-trip.
- **No arbitrary remote shell** — the only injection target is the agent session.

## 3. Architecture overview

**Components:**
- `tg` (existing one-shot sender) — outbound unchanged; gains a guarded lazy
  auto-start of `tg-ctl`.
- `tg-ctl` — the control daemon / channel server. One binary, two modes:
  - **Channel mode (priority):** runs as a Claude Code channel (MCP server)
    spawned by `claude --channels …`. Owns Telegram I/O. Handles inbound
    text + photo/file, replies via the channel reply tool with `tg` branding.
  - **Poll mode (fallback):** standalone daemon, long-polls Telegram
    `getUpdates`, injects into the target tmux session via `send-keys`.
    Photo/file inbound → advises "restart with channels".
- **Hook installer** — writes the question/permission-forwarding hooks into
  `~/.claude/settings.json`.

**Transport selection / priority:**
- Channel has priority. If a channel instance is active for the bot → it owns
  I/O; poll-mode `tg-ctl` must **not** also poll (avoids Telegram 409, the
  competitor bug class #36800).
- If no channel → poll mode owns I/O and uses tmux.
- Enforced by a shared singleton lock keyed on the bot token (§6).

## 4. Round-trip mechanic

- **Poll/tmux mode:** `tg-ctl` injects the inbound message **wrapped**:
  `[TG from <name>] <message> — reply via tg`. The agent does the work and calls
  `tg "answer"` (curated, branded). Loop closes with no scrape, no completion hook.
- **Channel mode:** the message arrives as a native `<channel>` event, wrapped the
  same way (`… — reply via tg`). **Outbound is always `tg`** — one branded, curated
  voice. The channel is **inbound-only** (one-way channels are supported); we do not
  implement a channel reply tool, so there is never a second, unbranded outbound
  format. Photo/file inbound is delivered as a downloaded path the agent can read.
  Trade-off: a channel reply tool would give native threading / typing indicators but
  would lose `tg`'s branding / auto-attach — rejected to keep a single voice (see D2, §12).

## 5. Transports

### 5.1 Channel (priority)

- **Recommendation: build our own custom inbound-only channel** (an MCP server
  implementing the channel protocol), not the official plugin. Rationale: the official
  plugin is a two-way bridge whose `reply` is the generic, unbranded voice we avoid;
  an inbound-only channel pushes messages in, leaves all outbound to `tg`, and shares
  the singleton lock so it can't double-poll the bot.
- **Risk:** custom channels ride `--dangerously-load-development-channels`
  (research preview, gated) with known preview bugs (#40064 permission relay,
  #36800 duplicate instances / 409). Document and keep poll/tmux as the stable
  fallback.
- **Alternative (faster, less control):** reuse `telegram@claude-plugins-official`
  and run `tg-ctl` in poll/tmux only when the official channel is absent.
  **DECISION DEFERRED TO REVIEW (§12).**
- **Capabilities (inbound-only):** inbound text + photo/file (auto-download). Outbound
  stays exclusively `tg`. Photo/file is the channel-only capability tmux cannot match.
  A one-way (inbound) channel is explicitly supported by the protocol, so no reply tool
  is implemented.
- **Launch:** alias/wrapper `claude --channels …`. The channel server is spawned by
  `claude` as a subprocess; its lifetime equals `claude`'s.

### 5.2 tmux (fallback + control verbs)

- **Target discovery:** locate the tmux session running `claude` (reuse `tg`'s pane
  detection via `TMUX_PANE`; `pgrep -f claude`). Target by session name.
- **Injection (proven recipe, extracted from competitor source):**
  - `tmux send-keys -t <S> -l "<text>"` — literal mode (multi-line / special-char safe).
  - `sleep ~0.4s`.
  - `tmux send-keys -t <S> Enter`.
  - Text and Enter are **separate** calls with a gap — a combined/too-fast Enter is
    dropped by the Ink TUI (the single most common failure in the other bots).
  - Control verbs (raw keys, no `-l`): `Escape` (exit picker), `BTab` (cycle
    permission mode).
- **`!stop` / interrupt:** `kill -SIGINT <claude-pid>` (via `pgrep`), not tmux `C-c`.
- **Photo/file inbound in tmux mode** → reply in TG: "tmux can't inject media —
  restart with channels."
- **No-tmux guard:** inbound arrives but `claude` not in tmux / no session → reply
  in TG: "Claude Code not in tmux → feedback won't work." The advised relaunch matches
  the configured transport: tmux mode → `tmux new -s claude 'claude'`; channel mode →
  `tmux new -s claude 'claude --channels …'`.

## 6. Singleton / idempotency (HARD requirement)

- **Exactly one poller per bot token.** Never two `tg-ctl` instances; never
  poll-mode + channel-mode polling the same bot.
- **Mechanism:** non-blocking `flock(2)` on
  `~/.config/tg-cli/tg-ctl.<botid>.lock`, held for the daemon's lifetime. A second
  start fails the `flock` → exits 0 (idempotent no-op). PID file
  `tg-ctl.<botid>.pid` for `status`/`stop`; stale pidfile cleared via `kill -0`.
- Channel mode takes the **same** lock (our custom channel can — a reason to prefer
  custom over official). If the lock is held by a channel instance, poll-mode
  auto-start is a no-op.
- **Race:** two concurrent `tg` calls both attempt auto-start → `flock` serializes;
  the loser exits.
- **Scope boundary (local-only):** `flock` guarantees one `tg-ctl` per *machine*.
  Telegram `getUpdates` allows one consumer per bot token *globally* — two machines
  polling the same `TG_BOT_TOKEN` → 409. So inbound control is **one machine per bot
  token**; multi-machine fleets need a bot-per-machine or a central router (D3, §12).
  Outbound `tg` (`sendMessage`) is unaffected — it works from any number of machines.

## 7. Lifecycle & auto-start

- **Commands:**
  - `tg-ctl start` — acquire lock, daemonize, begin poll (poll mode). No-op if running.
  - `tg-ctl stop` — read pidfile, `SIGTERM`, clean lock/pidfile.
  - `tg-ctl status` — running? mode? target session? bot id?
- **Lazy auto-start from `tg`:** on `tg` invocation, auto-start `tg-ctl` **only if both hold**:
  - inside a tmux pane (`TMUX` set) with a detected AI agent, **and**
  - config `control.enabled: true`.
  - **No TTY check.** The agent calls `tg` through Claude Code's Bash tool with stdout
    piped, so `isatty` is false in the *exact* scenario we want to fire — a TTY gate
    would kill the headline trigger. The `TMUX` check already excludes CI/cron (no
    `TMUX` there), doing the protective work without breaking the feature. (Verify
    `isatty` under the Bash tool before relying on this.)
  - **Cleaner alternative / complement:** a `SessionStart` hook starts `tg-ctl` once
    when `claude` launches in tmux, instead of on every `tg` call. Auto-start-from-`tg`
    stays as a fallback; both are idempotent via `flock`.
- Auto-start is fire-and-forget and idempotent (`flock` guarantees a single instance).

## 8. Question / permission forwarding (the only hooks)

Installed idempotently into `~/.claude/settings.json` (backup first):
- `PreToolUse` matcher `AskUserQuestion` → forward question + options to TG as inline
  buttons → return
  `{hookSpecificOutput:{permissionDecision:"allow", updatedInput:{questions, answers:{<q>:<label>}}}}`.
- `PermissionRequest` → forward tool + args → Approve/Reject buttons → return
  `{hookSpecificOutput:{decision:{behavior:"allow"|"deny"}}}`.

These work **without** channels (pure hook return-value path). **No completion/Stop
hook.** The hook process hands the question to the running `tg-ctl` (local socket /
file handoff) and awaits the button answer.

**Fast-passthrough guard (critical):** these hooks live in `~/.claude/settings.json`
and fire for **every** Claude Code session, including keyboard sessions with no
Telegram. They MUST return *no decision* instantly unless **(a)** `tg-ctl` is running
**and (b)** this session is the active TG-control target (matched by tmux session / cwd
via a registration file written by `tg-ctl`). Otherwise they passthrough with zero added
latency — a normal keyboard session, or any session with no `tg-ctl`, is never blocked,
delayed, or hung waiting for a button tap.

## 9. Config

- `~/.config/tg-cli/.env`: `TG_BOT_TOKEN`, `TG_CHAT_ID` (existing). Allowlist =
  `TG_CHAT_ID` (+ optional extra IDs).
- `config.yaml` (under the existing feature-flag system):
  - `control.enabled`: bool, default `false` — gates inbound + auto-start.
  - `control.transport`: `auto | channel | tmux`, default `auto` (channel-priority).
  - `control.session`: optional fixed tmux session name (else auto-discover).
  - `control.inject_wrap`: template, default `[TG from {name}] {msg} — reply via tg`.

## 10. Error handling / edge cases

- Bot token shared by `tg` (`sendMessage`) and `tg-ctl` (`getUpdates`): `sendMessage`
  does not conflict with the long-poll; only one `getUpdates` consumer is allowed →
  enforced by the singleton.
- `claude` not running → inbound reply: "no active session".
- Multiple tmux sessions with `claude` → pick the one matching cwd/pane; if
  ambiguous, ask which (buttons) or use `control.session`.
- Channel preview bugs → poll/tmux is the stable fallback.
- send-keys into an open picker → optional `Escape` prelude (configurable), matching
  oscarsterling.
- Hook fires but `tg-ctl` is not running, or this session is not the TG-control target
  → **fast passthrough**, no decision, no latency (§8). A keyboard session is never blocked.

## 11. Testing

- **Unit:** `tg-ctl` arg parse; flock singleton (spawn two, assert one exits);
  wrapped-inject formatting; `settings.json` hook install/uninstall idempotency +
  backup; no-TTY auto-start skip.
- **Integration (tmux):** throwaway tmux session running a stub TUI; assert
  `send-keys -l` + `Enter` lands the line; assert the `SIGINT` path.
- **Hook:** feed a synthetic `AskUserQuestion` payload on stdin; assert the correct
  `updatedInput` JSON on stdout after a simulated button answer.
- **No live Telegram in CI:** mock the Bot API (`getUpdates`/`sendMessage`) with a
  local fake.

## 12. Open decisions for review

- **D1 — Channel: custom inbound-only (recommended) vs official two-way plugin.**
  Recommendation: custom inbound-only channel + outbound always `tg` (one branded
  voice). The official plugin is a two-way bridge whose reply is the unbranded voice we
  avoid. Affects branding, lock-sharing, preview-risk exposure. Pick before the plan.
- **D2 — Outbound voice.** Recommended: `tg` only (channel inbound-only). Alternative:
  a channel reply tool for native threading / typing, at the cost of `tg`'s branding /
  auto-attach. Confirm `tg`-only.
- **D3 — Fleet.** One machine per bot token (Telegram `getUpdates` limit). For
  mbp + home on one bot, choose: bot-per-machine, or a central router that owns the
  single poll and fans out. Decide before multi-machine use.

## 13. Out of scope / future

- Voice inbound, file-preview tunnels, multi-machine fleet routing, web dashboard
  (the monetization-hypothesis layer) — separate specs.

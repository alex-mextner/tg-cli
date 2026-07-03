# AGENTS.md — tg-cli

Agent-facing documentation. English only.

---

## What This Repo Is

`tg` is a single-file Bun/TypeScript CLI (`#!/usr/bin/env bun`, entrypoint: `tg` at repo root,
no build step) that sends curated agent reports to Telegram via the Bot API.

Credentials: `~/.config/tg-cli/.env` — must contain `TG_BOT_TOKEN` and `TG_CHAT_ID`.

---

## CRITICAL: This Checkout Is the Live Binary

`~/.files/bin/tg` (on PATH) is a symlink to `<repo>/tg`. Whatever branch is checked out in
`~/.files/repos/tg-cli` **IS** the deployed tool, with immediate effect.

- Keep `main` checked out here at all times.
- Never leave the checkout on a half-done feature branch.
- Do all feature work in git worktrees on separate branches.

## Hook Caller Discipline

When a hook needs clearer callee semantics, fix the callee command surface and invoke that
surface directly. Do not change cwd, hide repo context, or add caller-side environment hacks
to coerce a tool into the desired mode; those workarounds make hook behavior depend on the
launch environment and leave help/docs stale.

---

## Architecture

Two single-file entrypoints at the repo root contain only thin wiring (real spawns, file
I/O, fetch, signals, `bun:ffi`):
- `tg` — outbound one-shot sender. Notable flags: `--format html` (HTML send; auto-routes
  to a native **Rich Message** — `sendRichMessage` — when the body contains a rich-only tag
  like `<table>`/`<h1>`/`<ul>`/`<hr>`/`<details>`/`<tg-math>`, otherwise normal `sendMessage`;
  see "Rich messages" below), `--tag`/`--title` (header badge; compose with rich),
  `--reply-to <message_id>` (thread the message UNDER an inbound one — `reply_to_message_id`
  on sendMessage, `reply_parameters` on sendRichMessage; the `answer` tag requires it),
  `--topic <id>` (post INTO a forum topic — stamps `message_thread_id` on EVERY outbound
  primitive so an agent's reply threads into its bound topic instead of General; falls back to
  the `TG_TOPIC` env, flag wins; no flag/env → General, byte-identical to before),
  `--table` (render STDIN rows — TSV or `a | b` — as an aligned monospace `<pre>` table; the
  PLAIN fallback grid — a real bordered table comes from `--format html` with `<table>`),
  `tg help format` (print the supported-HTML reference, basic + rich tiers; the topic-help
  convention — `--format-help` is a back-compat alias).
- `tg-ctl` — inbound control daemon (`run`/`start`/`status`/`stop`/`enable`/`disable`):
  singleton via real `flock(2)` over `bun:ffi`, Telegram `getUpdates` long-poll, tmux pane
  injection. The lifecycle subcommands follow the shared agent-tools service-management
  contract (`agenttools_service`): `run` = foreground/blocking; `start` = background detached
  daemon; `status` = running?/pid/bot/target/autostart; `stop` = stop the background daemon;
  `enable` = install OS autostart AND start now; `disable` = remove autostart AND stop. A bare
  `tg-ctl` (no subcommand) prints HELP and never launches. OS-autostart matrix lives in
  `features/tg-ctl/autostart.ts`, mirroring the lib's SEMANTICS: macOS → launchd LaunchAgent
  (label `com.agenttools.tg-ctl.tg-ctl`, `RunAtLoad` + `KeepAlive{SuccessfulExit:false}`,
  legacy `launchctl load`/`unload`); Linux with a usable `systemctl --user` → systemd `--user`
  unit (`agenttools-tg-ctl-tg-ctl.service`, `Restart=on-failure`, `enable --now`); any other host
  (Linux with no `systemctl --user` — containers, no D-Bus session — or an unsupported OS) → a
  no-op fallback that starts now but won't survive reboot. tg-ctl is Bun/TS so it
  reproduces the lib's CONTRACT, not its code; the full Python code-share happens when tg-cli
  grows a Python seam (follow-up). Spec: `docs/specs/2026-06-10-tg-ctl-control-design.md`
  (§16 = shipped v1 scope). After merge to main it gets its own `~/.files/bin/tg-ctl` symlink
  (same live-symlink rule as `tg`).

Feature modules live in `features/<feature-name>/` as **pure TypeScript modules** — no I/O;
all external dependencies (spawns, fetch, file reads) are injected as function parameters so
tests can pass fakes.

### Existing Features

- `features/auto-attach/` — path detection → attach files, R1-R4 text rules, line-spec quotes,
  worktree-aware + recursive path resolution, transmitter with Telegram message/caption limits.
- `features/autolink-tasks/` — detects Linear ticket codes in messages, resolves titles via the
  `linear` CLI, and rewrites text with hyperlinks.
- `features/autolink-prs/` — detects GitHub `#N` refs, resolves them against the cwd repo via
  `gh` (issues merge into the tickets block, PRs get their own block), repo-keyed 1 h cache.
- `features/autolink-msgrefs/` — links `tg#<id>` inbound-message references (the convention the
  inbound inject wrap renders, distinct from a GitHub `#<id>`). Pure detection runs FIRST in the
  outbound transform — before the `#N` PR pass — so a `tg#3715` is never mis-resolved as issue/PR
  #3715. Builds a `t.me/c/` deep link for a supergroup chat; in a private DM the ref is marked but
  unlinked (no public per-message URL exists).
- `features/autolink-refs/` — shared compound-ref parser (ranges/lists like `HYP-100..103/110`,
  `#5-7,9`): body links the written numbers, the bottom block enumerates the full range. Used by
  both autolink features (docs/specs/autolink-compound.md).
- `features/md-pdf/` — disk-sourced `.md`/`.markdown` attachments → PDF (pandoc + headless Chrome)
  before upload, because Telegram mangles non-ASCII text previews. Shared `ConvertDeps` / `findChrome`.
- `features/code-pdf/` — disk-sourced code/config attachments (`.ts`, `.json`, `.yaml`, `Dockerfile`,
  … per a maintainable extension/filename→highlight-language map) → a **mobile-sized,
  syntax-highlighted, soft-wrapped** PDF (reuses the md-pdf pipeline; pandoc skylighting + Chrome
  `--print-to-pdf` at a device page size). **By default ONLY the PDF is sent** (the raw file is
  useless on iOS); `--with-original` sends both, `--no-pdf` sends the raw file. `--pdf-device` /
  `TG_PDF_DEVICE` pick the page geometry. `applyCodePdfToPlan` is the pure attach-decision used by `tg`.
- `features/prefix-style/` — Unicode styling of the outbound prefix: tmux window name → Sans-Serif
  Bold, single-ticket task title → Bold Italic, with `<b>`/`<i>` fallback for Cyrillic
  (docs/specs/unicode-prefix-styling.md).
- `features/render/` — pure outbound-render helpers used by `tg`: `html.ts` (escape, tag detection,
  parse-mode, emoji-entity → `<tg-emoji>`), `rich.ts` (Rich Message detection + limit validation —
  `isRichHtml` flags rich-only tags so a body routes to `sendRichMessage`, `validateRichHtml`
  pre-flights the documented limits), `prefix.ts` (the `✳️ [window]` header + tag/title
  badge), `tag.ts` (the lowercase-english tag set — answer/decision/problem/report — validated
  at parse time via `validateTag`), `table.ts`
  (`--table`: delimited STDIN rows → an aligned, box-drawn, HTML-escaped monospace `<pre>` table —
  alignment is computed on raw cells so escaping never skews columns), and `format-help.ts`
  (the supported-HTML reference, basic + rich tiers — surfaced via `tg help format`, with
  `--format-help` kept as a back-compat alias).
- `features/tg-ctl/` — inbound control logic: `control:` config block parser, singleton/pidfile
  helpers, the update→action step function (allowlist, staleness, command split, `/agent`
  routing, reply-quote forwarding), tmux inject plans as data, agent pane discovery (process-tree
  walk — a Claude Code pane reports its VERSION string as `pane_current_command`, not `claude`),
  `agent-match.ts` (phonetic fuzzy window matching + session-grouped selection buttons),
  `routes.ts` (message_id→pane map for reply recognition + LRU/MRU picker), `hook-normalize.ts`
  (raw harness hook payload → ButtonRequest; also forwards Claude Code `ExitPlanMode` plan-approval
  — delivered by the `PermissionRequest *` catch-all — as a permission with Proceed/Keep-planning
  buttons + the plan body, stamping `permissionEvent` so the hook reply matches the firing event:
  PreToolUse→`permissionDecision`, PermissionRequest→`decision.behavior`), `hook-install.ts`
  (idempotent q→buttons + harness-event hook merge for `tg-ctl install-hooks` — PreToolUse matches
  `AskUserQuestion`, a `PermissionRequest *` catch-all that also carries plan-approval (ExitPlanMode
  gets NO dedicated matcher to avoid double-forwarding, since both events fire for it), plus a
  `StopFailure *` group running `tg-ctl harness-event`), `limits.ts` (tg-cli#113: limit-stop
  classification from the transcript's synthetic failure text, IANA-zoned reset-time parsing, the
  durable scheduled-auto-continue store `tg-ctl.<botid>.limits.json`, the `tgw:` button codec and
  the notification card — the daemon arms a timer per tapped card that injects «продолжай» into
  the stopped pane at reset time; `tg-ctl harness-event` degrades to a direct button-less send
  when the daemon is down), `question-store.ts`
  (PURE (de)serialization for the durable forwarded-question state — the on-disk envelope +
  age/count pruning; the entrypoint owns the atomic file I/O and the authoritative req
  normalization), `defer.ts` (defer-while-waiting queue model: inbound text is
  QUEUED per-pane while that pane has an open question and flushed on answer, so it is never pasted
  into the prompt — `driveFlush` re-checks the pane before EACH paste so a follow-up question
  re-defers the untouched tail), and `voice.ts` (inbound VOICE→text: `voice:` config block
  parse/resolve/upsert, ffmpeg + whisper argv builders, transcript cleaning, and the onboarding
  decision). `voice-probe.ts` is the ONE impure module here — it scans `~/xp` for an existing
  Whisper install (whisper.cpp binary + ggml model, or a faster-whisper venv) and checks for
  `ffmpeg`, handing a pure `WhisperProbe` to `decideOnboarding`. Shared shapes in `types.ts`.
- `features/replies/` — the `tg replies` subcommand (message recall). All PURE except `cli.ts`,
  which is effectful-via-DI like `features/hooks/cli.ts` (the I/O — history read, `$TMUX_PANE`
  detection, stdout — is injected as `RepliesCliDeps`, so the orchestration is unit-tested without
  disk/tmux). `history.ts` (the `HistoryRecord` type + JSONL parse/serialize/append/trim, plus
  `appendRecordsToBlob` — the whole read-append-trim as one pure string transform the entrypoints
  wrap with readFile/writeFile), `args.ts` (`tg replies [user|agent|all] [list|find <q>]` + flags),
  `select.ts` (direction + pane filters, substring/regex search, the select pipeline, line + JSON
  formatters), `inbound.ts` (raw `getUpdates` batch → `user` history records, mirroring
  `stepUpdates`' allowlist + staleness), `outbound.ts` (which text to log for a send — body or a
  `[photo]`/`[document]` placeholder).

- **Message history & recall (`tg replies`, v1.11.0):** an append-only JSONL log at
  `tg-ctl.<botid>.history.jsonl` (path added to `CtlPaths`, next to `routes`) records one
  `{ts, message_id, direction, from, text, pane}` object per line. TWO writers, both best-effort
  (a corrupt/unwritable log NEVER breaks a send or an inject, exactly like `routes`): the `tg-ctl`
  poll loop appends every inbound message it processes (stamped with the routed target pane), and
  `tg` appends one `agent` record per send (stamped with `$TMUX_PANE`, the first sent message id).
  The file is trimmed to its last ~5000 lines on each write. `tg replies` defaults to the CURRENT
  pane's session + `user` direction ("recall what the user wrote"); `--all-sessions`/`--session`
  override scope, `--json` is machine-readable, `find`/`--regex` search. Exact-match leading token
  in `tg` dispatch (like `hooks`/`voice`), so `tg "replies ..."` as a plain message still sends.
  - **Reply pane accuracy:** a text/voice reply is stamped with its recognized ORIGIN pane (the
    same pane reply-route delivers it to); a photo/document reply or a `/agent <window> …` routing
    command is stamped with the DEFAULT discovered pane (those route elsewhere, but they are media
    receipts / routing directives, not conversational content — acceptable for recall).
  - **Known limitation (matches `routes`):** both writers do read-modify-write rather than a true
    `O_APPEND`, so a daemon-inbound write racing a concurrent agent-outbound write could lose a
    record. The daemon is the single inbound writer and outbound writes are short; a file lock is
    out of scope for a best-effort, bounded log (same posture as the `routes` map).

- **Durable forwarded-question state (`tg-ctl.<botid>.questions.json`, v1.20.0):** the daemon held
  all question state ONLY in memory (`pendingButtons`/`activeButtonKeys`/`answeredButtons`), so a
  hook socket close or a daemon restart lost it. The daemon now persists scoped questions + the
  answered-replay cache to this file (path on `CtlPaths`, atomic temp+rename write) on every
  mutation, and restores them on bootstrap. Three guarantees, one mechanism: (a) **late-delivery** —
  a tap that lands after a question's hook socket closed (the agent's 120s budget elapsed, or it
  died) injects the chosen option into the asking pane (the text-reply inject path) instead of
  hitting the `!pending` drop; the retained card keeps its keyboard. A socket-closed scoped question
  moves out of `pendingButtons` into `abandonedButtons` (so it never defers its pane's inbound) and
  is retained for `TG_CTL_ABANDONED_RETAIN_MS` (default 30 min) — a window enforced at delivery time
  (not only on restore), so a tap past the window expires rather than injecting a long-stale answer,
  even on a quiet daemon with no intervening mutation. (b) **lossless reconnect** — the
  `tg-ctl ask` client for a SCOPED question reconnect-and-resends the same requestId across a
  mid-block socket drop; the restored daemon re-attaches the pending entry (no duplicate card) or
  replays the stored answer (#98, now persisted). (c) **dead-card UX** — a genuinely-dead card (an
  unscoped question, or a send-failed forward) has its inline keyboard cleared on expiry.
  Permissions + unscoped questions keep the single-attempt client path (resending would duplicate
  the card). `question-store.ts` owns the on-disk format (PURE); the entrypoint owns the I/O.

- **Inbound voice (STT):** a Telegram voice/audio note → `transcribe-voice` action (updates.ts).
  The daemon downloads the OGG, transcodes to WAV 16 kHz mono via `ffmpeg`, runs the configured
  local Whisper, cleans the transcript, then routes it through the SAME path a typed message uses
  (reply-route with the quote anchor when the note is a reply, else inject into the discovered
  pane). An unconfigured note triggers a guided onboarding reply — never a silent drop. Configure
  with `tg voice setup` (→ `tg-ctl voice-setup`), which probes `~/xp` and persists the `voice:`
  block. Whisper/ffmpeg/network spawns are all timeout-guarded.

- **Threaded replies:** the injected wrap (`injectWrap` in `DEFAULT_CONTROL`,
  `[TG from {name} {id}] {msg} — reply via tg`) now carries the inbound Telegram `message_id`
  via the `{id}` placeholder (rendered `#<id>`; collapses cleanly when no id applies, e.g. an
  `/agent` route). The agent passes that id to `tg --reply-to <id>`, which sets
  `reply_to_message_id` on the FIRST outbound `sendMessage` so the answer threads under the
  message it answers. The id IS Telegram's own per-chat sequential `message_id` — no parallel id
  scheme. `wrapInbound` takes an optional `messageId`; `stepUpdates`/`buildReplyInject` forward
  `m.message_id`; the `download-media` / `transcribe-voice` actions carry it too.

### Feature Flags

Defined in `features/auto-attach/feature-flags.ts` as a default-ON map. Overridable by:
- `~/.config/tg-cli/config.yaml` (`features:` block)
- `--feature <name>` / `--no-feature <name>` CLI flags

### Specs

Specs are authoritative. They live in `docs/specs/<feature>.md`. Read the relevant spec before
touching any feature.

---

## Conventions

- **TDD**: write tests in `tests/*.test.ts` first; run with `bun test ./tests` (scope to `./tests` —
  a bare `bun test` from a parent dir falsely grabs sibling-repo tests). All 1460 tests must pass.
- **Codex review** before committing non-trivial changes: `codex exec review --uncommitted`
  (findings appear at the end of output after thinking/exec noise — use `tail -80`).
- **Version bumps**: the `VERSION` const in `tg` must have a matching `## <version>` section in
  `CHANGELOG.md`. A test asserts this — do not forget it.

---

## Useful Gotchas

**Telegram HTML validation** — Telegram strictly validates HTML in messages. A successful send
(CLI prints `OK`, exit 0) also proves the generated markup is valid. Useful as an e2e smoke
test.

**Message size limits** — Telegram caption limit is 1024 visible chars; message limit is 4096.
The transmitter layer in `features/auto-attach/` handles overflow and splitting automatically.
Never duplicate that logic in feature modules.

**Rich messages (`--format html`, auto-routed)** — Bot API 10.1 (June 2026) added
`sendRichMessage`, which renders a much larger HTML tag set than the basic `parse_mode=HTML`
path: native tables (`<table>`/`<tr>`/`<td>`, `align`/`valign`/`colspan`/`rowspan`/`<caption>`),
headings (`<h1>`..`<h6>`), lists (`<ul>`/`<ol>`/`<li>`), dividers (`<hr>`), paragraphs (`<p>`),
collapsible `<details>`, pull quotes (`<aside>`), footers, and LaTeX formulas (`<tg-math>` /
`<tg-math-block>`). There is **no new flag and no new `--format` value** — rich goes THROUGH
the existing `--format html`. `tg` decides by CONTENT (`isRichHtml` in `features/render/rich.ts`):
a body using only the basic inline tags (b/i/u/s/code/pre/a/blockquote/tg-emoji/tg-time/spoiler)
sends via `sendMessage` as before; a body containing any rich-only tag sends via
`sendRichMessage` with `rich_message.html` (NOT a parse_mode — `InputRichMessage` takes exactly
one of `html`/`markdown`). A rich body is sent WHOLE (never 4096-split — that would corrupt a
`<table>`; rich has a 32768-char budget — and never used as a media caption). `--tag`/`--title`
compose (the branded header uses only basic tags, valid inside a rich body); `--reply-to`
threads via `reply_parameters`. Rich limits (≤ 32768 chars, ≤ 500 blocks, ≤ 16 nesting levels,
≤ 50 media, ≤ 20 table columns) are pre-flighted in `validateRichHtml` before the send. The
monospace `tg --table` (`<pre>`) stays as the plain fallback grid.

**linear CLI** — `autolink-tasks` uses schpet/linear-cli.
- Install: `brew install schpet/tap/linear` (NOT `brew install linear` — that installs the
  Linear desktop app cask).
- Auth: `linear auth login`.
- Batch resolution: use a single `linear api '<GraphQL>'` call with a filter query. Aliased
  `issue(id:)` queries are broken for batches — one missing issue nulls the entire response.

**Manual smoke sends** — the `bun test` suite never sends anything real. During development,
sending a few real messages to the configured chat as proof IS accepted practice in this repo
(the chat owner reads them). Keep them few and informative.

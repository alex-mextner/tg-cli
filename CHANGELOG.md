# Changelog

All notable changes to `tg` are documented here. This project adheres to
semantic versioning.

## 1.9.3

Cleaner tag header + emoji tooling reads its bot token from config.

- **No more duplicate tag word on the header line.** A `--tag` with real pill ids
  now renders ONLY the wordmark pill cells in the HTML header — the appended
  plain tag word (e.g. a second "ANSWER" next to the pill) is gone. The wordmark
  is already baked into the sticker art, so the duplicate was redundant and (when
  combined with `--title`) clashed with the styled title. The first line is now
  the `--title` text (styled) only; the tag is just the pill badge. Non-premium
  viewers fall back to the per-cell colored dots — an accepted trade for a clean
  premium first line. The `plain` form (non-HTML / >4096 split) keeps the
  readable unicode fallback (`🔵 ANSWER`). Unknown tags still soft-render as
  `[WORD]`. (`features/render/prefix.ts`.)
- **Emoji-set scripts read their bot token from config, decoupled from the
  sender.** `scripts/create-tag-emoji.ts` and `scripts/create-ai-emoji-set.ts`
  now read `TG_EMOJI_BOT_TOKEN` (the dedicated emoji-owning bot) from
  `~/.config/tg-cli/.env`, falling back to `TG_BOT_TOKEN` only when unset; owner
  id is `TG_OWNER_ID` then `TG_CHAT_ID`. They use the shared config loader
  (`features/config/env.ts`, extracted from the `tg` entrypoint) so the config
  `.env` → process.env precedence applies and a token set only in config works
  with no transient shell export. The token is never printed.
  (`features/config/env.ts`, `scripts/create-tag-emoji.ts`,
  `scripts/create-ai-emoji-set.ts`, `tg`.)

## 1.9.2

Code/config files → mobile, syntax-highlighted PDF (and by default ONLY the PDF
is sent).

- **`code-as-pdf` feature (ON by default).** Attaching a code/config file —
  `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`, `.jsonc`, `.yaml`,
  `.yml`, `.toml`, `.ini`, `.py`, `.go`, `.rs`, `.rb`, `.php`, `.java`, `.kt`,
  `.swift`, `.c`, `.cpp`, `.h`, `.cs`, `.sh`, `.bash`, `.zsh`, `.sql`, `.css`,
  `.scss`, `.less`, `.html`, `.xml`, `.svg`, `.graphql`, `.proto`, `.lua`, `.r`,
  `.dart`, `Dockerfile`, `Makefile`, `CMakeLists.txt`, … (full map in
  `features/code-pdf/convert.ts`) — is rendered to a **mobile-sized,
  syntax-highlighted, soft-wrapped PDF** before sending. Telegram's iOS client
  previews raw source uselessly; the PDF is the readable artifact on a phone.
  Pipeline reuses the md-pdf machinery: fence the content in the detected
  language → pandoc (skylighting highlighting) → headless Chrome
  `--print-to-pdf` at the phone page size. Long lines **soft-wrap** (CSS
  `white-space: pre-wrap` + `overflow-wrap: anywhere`) so there is NO horizontal
  scroll. Monospace, light theme (`tango`), optional line numbers.
- **BY DEFAULT only the PDF is sent — the raw file is NOT attached.** On iOS the
  raw `.ts` is noise; the PDF is what you actually read. Two flags adjust:
    - **`--with-original`** — also attach the raw file alongside the PDF.
    - **`--no-pdf`** — skip the render and attach the raw file (the prior
      behavior). Equivalent to `--no-feature code-as-pdf`.
- **`--pdf-device <name>`** (or `TG_PDF_DEVICE`) — page geometry preset:
  `iphone15pro` (default, 393pt wide), `iphone15promax`, `iphonese`, `a4`.
  `TG_PDF_THEME` overrides the pandoc highlight style (default `tango`).
- Markdown keeps its own `.md`→PDF path (`detectCodeLang` returns null for it);
  images / `.pdf` / other documents are untouched. On any render failure the raw
  file is attached unchanged (same fail-open policy as md-as-pdf).
  (`features/code-pdf/convert.ts`, `features/cli/args.ts`,
  `features/auto-attach/feature-flags.ts`, `tg`.)

## 1.9.1

Wider tag pills, hosted under @hyperidebot.

- **ANSWER and REPORT widened to 3 cells.** 1.9.0 sliced the two 6-letter
  wordmarks into 2 cells each, so the rounded caps squished the text. Both now
  use 3 cells (matching DECISION / PROBLEM), giving the wordmark breathing room.
  The generator (`scripts/build-tag-pills.py`) sets all four canonical tags to 3
  cells; the upload script and render path follow.
- **Pill set re-created under @hyperidebot.** The custom-emoji set moved from
  `replytags_by_UltraClaudeCodeBot` to
  [`replytags_by_hyperidebot`](https://t.me/addemoji/replytags_by_hyperidebot)
  (12 cells, 3 per tag). The sending bot does NOT need to own the set — it can
  reference a set owned by a different bot (verified live). The old set was
  deleted.

## 1.9.0

Custom-emoji tag pills go live.

- **`--tag` now renders a real custom-emoji wordmark PILL.** 1.8.0 shipped the
  `--tag` plumbing with PLACEHOLDER pill ids, so every tag fell back to the
  unicode badge (`🔵 ANSWER`). This release uploads the pill sticker set
  (`replytags_by_UltraClaudeCodeBot`, https://t.me/addemoji/replytags_by_UltraClaudeCodeBot)
  and wires the real `custom_emoji_id`s into `TAG_PILL_IDS`. Premium clients now
  see the wordmark chip; everyone else sees the unicode fallback. The four pills
  (🔵 ANSWER / 🟠 DECISION / 🔴 PROBLEM / 🟢 REPORT) are sliced into 2–3 cells
  each. (`features/branding/emoji.ts`, `scripts/create-tag-emoji.ts`.)
- **Fix: pill cells wrap a single emoji, not a slice of the word.** Telegram
  rejects a `custom_emoji` entity whose fallback text is not exactly one emoji
  with `ENTITY_TEXT_INVALID`. The renderer now emits one `<tg-emoji>` per cell
  wrapping the canonical dot (`🔵`), and appends the readable WORD as plain text
  after the cells (`<pill cells> ANSWER`) so the label is never lost — premium
  clients see the pill image + word, non-premium see `🔵🔵 ANSWER`. The dead
  `splitForCells` word-distributor (the discarded slice approach) is removed.
  (`features/render/prefix.ts`.)

## 1.8.0

Header tag/title; revert the body-pull from 1.7.1.

- **The message body is no longer pulled onto the `✳️ [window]` header line.**
  1.7.1 joined the body's first line onto the header (the prefix ended with a
  space instead of a newline). That was a mistake: the message text must NOT be
  pulled up. `buildPrefix` now ends the header with a newline again, so the body
  always sits BELOW `✳️ [window]` (the pre-1.7.1 behavior). The single-ticket
  autolink title still renders on the header line (it is a ticket title, not
  message text), and the 1.7.1 reply-routing fix is untouched.
  (`features/render/prefix.ts`, `features/autolink-tasks/render.ts`, `tg`.)
- **`--title <text>`** — set an explicit header title: `✳️ [window] <title>`.
  ONLY an explicit `--title` ever appears there; the message body is never
  pulled up. No `--title` → the header is just `✳️ [window]` with the body
  below. The title is styled Bold Italic (a Cyrillic title falls back to `<i>`).
- **`--tag <TAG>`** — an emoji badge labeling what the message is. Canonical
  tags are Russian and case-insensitive; English aliases map to them:
  ОТВЕТ/ANSWER (🔵 💬), РЕШЕНИЕ/DECISION (🟠 ⚖️), ПРОБЛЕМА/PROBLEM (🔴 🚨),
  ОТЧЁТ/REPORT (🟢 📋). It composes with `--title`:
  `✳️ [window] 🔵 💬 ОТВЕТ — <title>`. An unknown tag soft-renders as a plain
  `[TAG]` badge plus a one-line stderr note (it never blocks a send). The
  default emoji mapping lives in one editable constant (`TAG_EMOJI` in
  `features/render/tag.ts`).
- **Skill advertising** — `tg install-skill` now documents `--tag`/`--title`,
  the four canonical tags, their English aliases, and their meanings in both the
  generated `SKILL.md` and the always-on blurb, so agents discover the
  convention from the skill itself.

## 1.7.1

Reply-routing + message-header fixes.

- **Reply routing no longer always opens the picker** — replying in Telegram to a
  message an agent sent now routes straight to that agent's pane. `tg` recorded
  the route's project identity as `process.cwd()`, but agents run `tg` from
  `/tmp`, so it never matched the daemon's check against the pane's
  `pane_current_path` and every reply fell through to the "choose an agent"
  picker. `tg` now records the origin pane's `pane_current_path` at send time, so
  send-time and reply-time compare the same quantity. The pane-id-reuse guard
  (a reply can't leak into a different project that reused the pane) is preserved.
  (`recordRoute` in `tg`, `resolveRouteCwd` / `routeMatchesPane` in
  `features/tg-ctl/routes.ts`.)
- **Task title / message body on the same line as `[window]`** — the agent
  header rendered `✳️ [window]` and dropped the task title / message text to line
  2. The prefix now joins the body with a space, so it reads
  `✳️ [window] 𝑻𝒂𝒔𝒌 𝒕𝒊𝒕𝒍𝒆` on one line. (`buildPrefix` in
  `features/render/prefix.ts`.)

## 1.7.0

Pre-send-photo hook framework + `review --visual` unstyled guard.

- **Pre-send-photo hook point** — `tg` now runs an extensible hook chain
  (`agents-hooks/v1`) over every outgoing `--photo` before it leaves. Drop a
  descriptor under `~/.agents/hooks/tg/<id>.pre-send-photo.json` (an executable
  with a priority / timeout / on-error policy) and it runs against the PNG; a
  hook can `allow` the send or `block` it with the canonical exit code 10.
  (`features/hooks/`, `tg hooks list|trust`.)
- **`review --visual` unstyled guard** — the bundled `review-visual` descriptor
  pipes the outgoing photo through `review --visual <png> --json --strict` and
  blocks an unstyled / broken / blank render before it ships. Vision is slow, so
  the hook runs with a 60s timeout and `on_error: open`: a slow or unavailable
  vision call NEVER blocks a send — only an explicit rollback verdict does.
  (`review install-hook tg` substitutes the absolute cmd path.)
- **Trust by default** — drop-in descriptors LOAD AND RUN with no `tg hooks
  trust` ceremony on the user's own machine. The legacy TOFU quarantine + SHA
  pin re-engages only under `AGENTS_HOOKS_TRUST=1` (the rare untrusted-input
  case); `AGENTS_HOOKS_TRUST=auto` runs under the guard but auto-trusts.
- **Fail-open, non-breaking** — no descriptors dir ⇒ a single `stat` and a
  byte-identical send (zero behavior change for existing users). A hook crash,
  timeout, or malformed output warns and sends anyway; only exit-10 blocks.
  Every run is recorded to an append-only `audit.jsonl`.

## 1.6.1

- **Task-title styling restyled** — the single-ticket autolink task title now
  renders in **Mathematical Bold Italic** (`𝑭𝒊𝒙`) instead of the gaudier Bold
  Script (`𝓕𝓲𝔁`). The whole-token `<i>` fallback for Cyrillic / foreign-letter
  titles (which the math block can't represent) is unchanged.
  (`features/prefix-style/`, docs/specs/unicode-prefix-styling.md.)

## 1.6.0

Agent addressing, reply quotes, prefix styling, and compound autolinks.

- **`/agent [<window>] <message>`** — address a specific agent when several run
  at once. The window is fuzzy-matched with phonetic normalization (Cyrillic→
  Latin, sound-folding), a confident match routes the message straight to that
  pane, and an ambiguous / unspecified target shows session-grouped inline
  selection buttons. Bare `/agent` lists the addressable agents.
  (`features/tg-ctl/agent-match.ts`, docs/specs/agent-addressing.md.)
- **Reply quotes + routing** — replying to a message forwards a quote anchor
  into the agent: `↩ «[date time] <quote>…»` (partial Telegram selection wins,
  else the start of the replied-to message). A reply to a **recognized** message
  routes to the pane that produced it (message_id→pane routes map written by
  `tg`); an **unrecognized** reply shows the window picker ordered by **LRU+MRU**.
  (docs/specs/reply-quotes.md.)
- **q→buttons, now seamless** — `tg-ctl install-hooks` idempotently wires the
  Claude Code agent-question/permission hooks into `~/.claude/settings.json`
  (backup first; existing hooks preserved); `tg-ctl ask` normalizes the raw
  harness payload so the hook is trivial; `tg-ctl status` reports whether it is
  installed. While an agent is blocked on a question, new inbound messages to it
  are **deferred** (queued, marked ✍️) and flushed when the question is answered.
  (docs/q-buttons-prerequisites.md.)
- **Unicode prefix styling** — the tmux window name in `[]` renders in
  Mathematical Sans-Serif Bold and a single-ticket task title in Bold Script,
  with a `<b>`/`<i>` fallback for Cyrillic names the math blocks can't represent.
  (`features/prefix-style/`, docs/specs/unicode-prefix-styling.md.)
- **Compound autolinks** — one token may carry a range or list of refs
  (`HYP-100..103/110`, `#5-7,9`): the body links only the written numbers
  (range endpoints), and the bottom reference block enumerates the full range.
  (`features/autolink-refs/`, docs/specs/autolink-compound.md.)
- Documented the q→buttons prerequisites and the missing hook installer
  (docs/q-buttons-prerequisites.md), and a WhatsApp companion-transport
  implementation spec (docs/specs/whatsapp-transport.md, spec only).

## 1.5.1

Agent detection fix (outbound branding):

- `tg` now identifies a `codex` (and `aider`/`pi`/`opencode`) session by walking
  its own ancestor process tree, not just an env marker. Codex exports no env
  signal for the shell commands it spawns (`CODEX` unset, `CODEX_HOME` empty),
  so detection used to fall through to the `pgrep` fallbacks where a background
  `ollama` daemon (common on macOS) won — mislabeling codex reports as `ollama`.
  The ancestry walk runs before the `pgrep` block, so the launching agent wins
  and a sibling daemon can no longer hijack the label. Mirrors `tg-ctl`'s
  inbound `findAgentInPane` (new `findAgentInAncestry`, shared `matchAgentCommand`).

## 1.5.0

Q→buttons (`tg-ctl`, spec §8 core path):

- New `tg-ctl ask` hook client: reads a normalized question / permission JSON
  request, hands it to the running daemon over a bot-scoped Unix socket
  (`tg-ctl.<botid>.sock`), sends Telegram inline buttons, consumes
  `callback_query` updates in the same poll stream, immediately
  `answerCallbackQuery`s every tap, edits expired/answered prompts, enforces
  the active registration guard (`paneId`/`cwd`/`sessionName`), and returns
  agent-specific hook output. A missing daemon/socket, timeout, or send
  failure returns no decision so the local agent UI takes over.
- Claude Code question and permission shapes are supported; Codex
  `PermissionRequest` emits the documented
  `hookEventName: "PermissionRequest"` decision shape; opencode
  `question.asked` / `question.v2.asked` / `permission.asked` /
  `permission.v2.asked` adapter helpers map to the matching native reply
  endpoints; `pi` is detected but reports native Q→buttons as unsupported.
- Hardening (post-review): the hook socket is `chmod 0600` on listen and
  caps requests at 64 KiB; taps are validated against the prompt's own
  Telegram `message_id` (a stale tap on an earlier message that reused the
  callback key answers "expired"); the registration guard treats `paneId` as
  authoritative — a pane mismatch fast-passes even when `cwd`/`sessionName`
  agree, so a second keyboard session in the same cwd never blocks on
  Telegram.
- Deferred (recorded in the spec): hook installer/canary automation,
  long-running opencode SSE ownership.

## 1.4.0

Inbound control v1 (`tg-ctl`, spec §16 — poll/tmux transport, ON by default;
opt out with `control.enabled: false`):

- New `tg-ctl` entrypoint at the repo root: `start` / `run` / `stop` / `status`.
  A singleton daemon long-polls Telegram `getUpdates` and injects inbound
  messages into the target agent's tmux pane, wrapped as
  `[TG from {name}] {msg} — reply via tg`. Outbound stays `tg`-only.
- Hard singleton via real `flock(2)` (`bun:ffi` → libSystem/libc): the launcher
  spawns the daemon detached and never takes the lock; the daemon flocks as its
  first action and exits 0 if another instance holds it.
- Lazy auto-start: a successful `tg` send from a tmux pane with a detected
  agent fire-and-forgets `tg-ctl start`, handing over the `TMUX_PANE`/cwd
  registration snapshot (gated on `control.enabled`).
- Pane-id targeting with pre-inject verification: the agent process is located
  by walking the pane's process tree (a Claude Code pane reports its version
  string, not `claude`, as the pane command); injection refuses + replies in
  Telegram if the pane no longer hosts an agent — text never lands in a shell.
- Commands: `/stop` (Escape inject — interrupts the turn, session survives),
  `/kill` (SIGINT + "restore via `claude --resume`"), `/status`; any other
  `/cmd` passes through verbatim; plain text is a wrapped prompt.
- Photo/document inbound: `getFile` download (≤20 MB) to
  `~/.cache/tg-cli/inbound/`, the local path is injected for the agent to read.
- Safety/robustness: sender-id allowlist, at-most-once offset persistence,
  staleness window (default 300 s) with a "skipped N stale" notice, 409
  backoff with a one-shot warning, idle TTL (default 30 min), multi-line
  injection via bracketed paste.
- Delivery receipts: a successfully handled inbound message gets a 👀
  reaction; every failure answers with an error reply instead.
- Config: new `control:` block (`enabled`, `transport`, `session`,
  `inject_wrap`, `staleness_sec`, `idle_exit_min`, `allowed_senders`).
  One bot token per machine for inbound (Telegram allows a single `getUpdates`
  consumer); outbound `tg` is unaffected.
- Deferred (recorded in the spec): question/permission forwarding with inline
  buttons (v1.1), opencode native adapter (v1.1), `/rename`+`/new` (v1.2),
  channel mode (v1.2+), configurable Escape prelude.

Also in this release:

- New `autolink-prs` feature (ON by default): GitHub `#N` references in the
  message text are resolved against the cwd repo via `gh` (one `gh repo view`
  for identity + one batched `gh api graphql` with aliased `issueOrPullRequest`
  fields) and linkified. Resolved ISSUES merge into the existing
  `autolink-tasks` reference block (`#N — Title`); PULL REQUESTS get their own
  collapsed `PRs:` block at the END of the message with a state annotation
  (`(merged)`/`(closed)`/`(draft)`/`(open)`). Verdicts (positive and negative)
  are cached 1 h in `~/.cache/tg-cli/gh-cache.json`, keyed by `owner/repo#N` so
  the same `#260` in different repos never collides. Every failure mode (no
  `gh`, not authenticated, non-GitHub cwd, partial/missing numbers) keeps the
  send going as plain text; missing-CLI / not-authenticated emit a one-time
  stderr hint reusing the `autolink-tasks` hint-state file. Disable with
  `--no-feature autolink-prs`.
- New `recursive-attach` feature (ON by default): a file mentioned by bare
  name or path suffix that misses plain and worktree-root resolution is now
  found recursively under the worktree roots (or cwd outside a git repo) —
  BFS, shallowest match wins, `node_modules`/`.git`/`dist`-style directories
  pruned, depth/size caps. `2026-06-10-tg-ctl-control-design.md` mentioned
  from the repo root now attaches from `docs/specs/`.
- `autolink-tasks` now retries one unexpected `linear api` failure before
  degrading to plain text, so transient Linear CLI/API failures do not silently
  drop ticket links.

## 1.3.0

Never-attach denylist (`attach-denylist` feature, ON by default):

- Secret-looking files are never attached: the `.env` family, SSH private
  keys (`id_rsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`), credential
  rc-files (`.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`,
  `.my.cnf`, `.htpasswd`), shell/REPL histories, `*.tfvars`,
  `credentials.json` / `client_secret*.json`, `kubeconfig`.
- Auto-detected mentions in the text are silently skipped (the token stays);
  an explicit `--photo`/`--file` of a denylisted file is a hard ERROR before
  anything is sent.
- Conscious override: `--no-feature attach-denylist` or
  `features.attach-denylist: false` in `~/.config/tg-cli/config.yaml`.

## 1.2.0

Attachment quality pass:

- Markdown as PDF (`md-as-pdf` feature, ON by default): attached `.md` files
  are converted to PDF via pandoc + headless Chrome — emoji and Cyrillic
  render correctly. Any conversion failure attaches the original `.md`.
- UTF-8 BOM for text attachments: documents with non-ASCII UTF-8 content get
  a BOM prepended to the uploaded copy (disk file untouched), fixing
  Telegram's preview mojibake for Cyrillic. Scripts (`.sh`) and `.json` are
  deliberately excluded.
- Extensionless files (LICENSE, Makefile, `.env`) are no longer auto-attached;
  explicit `--photo`/`--file` still attach anything.
- Linear response cache: autolink-tasks verdicts (including verified-absent)
  are cached for 1 hour in `~/.cache/tg-cli/linear-cache.json` — repeated
  reports about the same tickets no longer spawn the `linear` CLI each send.

## 1.1.0

Autolink tasks (`autolink-tasks` feature, ON by default):

- Ticket-like codes in the message text (3 uppercase letters + dash + digits,
  e.g. `HYP-576`) are verified against Linear via the `linear` CLI and turned
  into links.
- A single mentioned ticket gets its title on the first line (after the
  emoji/[window] prefix when present); several tickets get a collapsed
  `<blockquote expandable>` reference block (`code: title`) at the end.
- Codes Linear doesn't know stay plain text. A missing `linear` CLI or missing
  auth produces a one-time stderr hint; the message is always sent unchanged
  on any autolink failure.
- Toggle with `--no-feature autolink-tasks` or
  `features.autolink-tasks: false` in `~/.config/tg-cli/config.yaml`.

## 1.0.0

CLI ergonomics pass:

- `-v` / `--version`: print version, the running git commit hash, and this
  changelog, then exit 0.
- Help anywhere: `-h`/`--help` (or no arguments at all) prints usage to stdout
  and exits 0 instead of sending an empty message.
- Auto-attach paths: existing file paths found in the message text are attached
  automatically (images as photos, everything else as documents) and excised
  from the caption.
- `OK` on success: a successful send prints `OK` to stdout.
- Unknown dashed flags are an error: a stray `--foo` prints help to stderr and
  exits non-zero instead of being sent as message text. All real flags
  (`--format`, `--photo`, `--file`, `--ls-emoji-helpers`, `--detect-model`) are
  still recognized — the unknown-flag check runs only after they are matched.

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

---

## Worktree Trap (Lesson Learned 2026-06-10)

Claude Code's `EnterWorktree` bases new worktrees on `origin/main` (default `worktree.baseRef:
fresh`), **not** on the current HEAD. If feature work is stacked on unmerged branches, a fresh
worktree silently gives you a stale codebase (e.g. missing `features/`).

After creating a worktree:
1. Verify the base: `git log --oneline -1` and `ls features/`.
2. If stale, run `git reset --hard <intended base branch>` before writing any code.

---

## Architecture

Two single-file entrypoints at the repo root contain only thin wiring (real spawns, file
I/O, fetch, signals, `bun:ffi`):
- `tg` — outbound one-shot sender.
- `tg-ctl` — inbound control daemon (`start`/`run`/`stop`/`status`): singleton via real
  `flock(2)` over `bun:ffi`, Telegram `getUpdates` long-poll, tmux pane injection.
  Spec: `docs/specs/2026-06-10-tg-ctl-control-design.md` (§16 = shipped v1 scope).
  After merge to main it gets its own `~/.files/bin/tg-ctl` symlink (same live-symlink
  rule as `tg`).

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
- `features/autolink-refs/` — shared compound-ref parser (ranges/lists like `HYP-100..103/110`,
  `#5-7,9`): body links the written numbers, the bottom block enumerates the full range. Used by
  both autolink features (docs/specs/autolink-compound.md).
- `features/prefix-style/` — Unicode styling of the outbound prefix: tmux window name → Sans-Serif
  Bold, single-ticket task title → Bold Italic, with `<b>`/`<i>` fallback for Cyrillic
  (docs/specs/unicode-prefix-styling.md).
- `features/tg-ctl/` — inbound control logic: `control:` config block parser, singleton/pidfile
  helpers, the update→action step function (allowlist, staleness, command split, `/agent`
  routing, reply-quote forwarding), tmux inject plans as data, agent pane discovery (process-tree
  walk — a Claude Code pane reports its VERSION string as `pane_current_command`, not `claude`),
  `agent-match.ts` (phonetic fuzzy window matching + session-grouped selection buttons),
  `routes.ts` (message_id→pane map for reply recognition + LRU/MRU picker), `hook-normalize.ts`
  (raw harness hook payload → ButtonRequest), and `hook-install.ts` (idempotent q→buttons hook
  merge for `tg-ctl install-hooks`). Shared shapes in `types.ts`.

### Feature Flags

Defined in `features/auto-attach/feature-flags.ts` as a default-ON map. Overridable by:
- `~/.config/tg-cli/config.yaml` (`features:` block)
- `--feature <name>` / `--no-feature <name>` CLI flags

### Specs

Specs are authoritative. They live in `docs/specs/<feature>.md`. Read the relevant spec before
touching any feature.

---

## Conventions

- **TDD**: write tests in `tests/*.test.ts` first; run with `bun test`. All ~578 tests must pass.
- **Codex review** before committing non-trivial changes: `codex exec review --uncommitted`
  (findings appear at the end of output after thinking/exec noise — use `tail -80`).
- **Version bumps**: the `VERSION` const in `tg` must have a matching `## <version>` section in
  `CHANGELOG.md`. A test asserts this — do not forget it.
- **Commit messages**: conventional-commit style, e.g. `feat(autolink-tasks): ...`.

---

## Useful Gotchas

**Telegram HTML validation** — Telegram strictly validates HTML in messages. A successful send
(CLI prints `OK`, exit 0) also proves the generated markup is valid. Useful as an e2e smoke
test.

**Message size limits** — Telegram caption limit is 1024 visible chars; message limit is 4096.
The transmitter layer in `features/auto-attach/` handles overflow and splitting automatically.
Never duplicate that logic in feature modules.

**linear CLI** — `autolink-tasks` uses schpet/linear-cli.
- Install: `brew install schpet/tap/linear` (NOT `brew install linear` — that installs the
  Linear desktop app cask).
- Auth: `linear auth login`.
- Batch resolution: use a single `linear api '<GraphQL>'` call with a filter query. Aliased
  `issue(id:)` queries are broken for batches — one missing issue nulls the entire response.

**Manual smoke sends** — the `bun test` suite never sends anything real. During development,
sending a few real messages to the configured chat as proof IS accepted practice in this repo
(the chat owner reads them). Keep them few and informative.

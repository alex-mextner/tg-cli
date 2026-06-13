# tg-cli — `tg` decomposition (Stage 4)

Repo: `~/.files/repos/tg-cli`. Decompose the 1728-line `tg` entrypoint into
`features/<feature>/` modules with a thin `tg`, **zero behaviour change**, mirroring
the review-cli `reviewlib` decomposition (Stage 0) and the
`docs/specs/2026-06-...` repo norm of splitting large files. Companion to the
visual-verification effort's architecture spec §8 ("decompose `bin/review` and
`tg` into a `features/` layout with a thin entrypoint").

## Why

`tg` is 1728 lines: arg parsing, emoji/branding maps, model detection, the prefix
builder, the render pipeline, autolink orchestration, the Telegram transport, and
the `main()` flow all inline. The repo already keeps pure logic in
`features/<feature>/` (auto-attach, autolink-*, tg-ctl, prefix-style,
autolink-refs); the entrypoint just hasn't followed. The decomposition pulls the
inline logic into modules so `tg` becomes thin wiring + the `import.meta.main`
guard — easier to read, test, and reconcile with parallel work (the
`feat-tg-photo-visual-hook` Stage 3 photo hook re-applies its small pre-send call
onto the decomposed `main`).

## Invariants

- **Zero behaviour change.** Every one of the 579 `bun test` tests stays green
  after each stage; a real send still produces identical bytes. No feature
  toggles, no reordering of the send pipeline.
- **Pure modules, injected I/O** (the repo's `features/` contract): spawns,
  fetch, file reads are function parameters so tests pass fakes. The entrypoint
  keeps the real I/O.
- **`tg` stays a single `#!/usr/bin/env bun` entrypoint** (no build step) — it
  imports from `features/`, it does not become a package install target. The
  `~/.files/bin/tg` symlink rule is unchanged.

## Target layout

Extract into `features/`, by concern (lowest-coupling first):

| Module | From `tg` | Surface |
|---|---|---|
| `features/cli/args.ts` | arg parsing §231-560 | `parseArgs`, `isImagePath`, `hasRealExtension`, `expandHome`, `resolveExistingFile`, `Format`/`ParseResult` types |
| `features/cli/version.ts` | §77-133 | `versionOutput`, `gitShortHash`, `latestChangelogSection` |
| `features/branding/emoji.ts` | §565-663 | `EMBEDDABLE_EMOJI_MAP`, `UNICODE_EMOJI_MAP`, `MODEL_EMOJI_MAP`, `EmojiEntity`, `ParsedText`, `parseEmojiHelpers`, `convertEntitiesToHtml` |
| `features/branding/detect.ts` | §664-720, main §841 | `detectAgentViaAncestry`, `isProcessRunning`, `extractBaseModel`, `detectAiModel`, `detectAiEmoji` |
| `features/render/html.ts` | main render §1281-1456 | `escapeHtml`, `detectHtmlTags`, `parseModeFor`, `renderText` builder |
| `features/render/prefix.ts` | main §1042-1093 | `buildPrefix` (depends on branding + prefix-style) |
| `features/transport/telegram.ts` | main §1602-1700 | the Transport (sendMessage/sendPhoto/sendDocument/sendMediaGroup), `checkResponse`, `recordRoute` |

`tg` keeps: env load, the `main()` flow that wires the above + the autolink
orchestration (which is already thin over `features/autolink-*`) + the tg-ctl
auto-start.

## State threading

`main()`'s inline closures capture locals (`BOT_TOKEN`, `CHAT_ID`, `API`, `home`,
`MODEL`, `AI_EMOJI`, `args`, feature flags). Extracted module functions take these
as explicit parameters (or a small `Ctx` record) instead of closing over them —
the same move reviewlib made. Pure helpers (args, emoji maps, detect, version)
capture nothing and extract first (Stage 0); the stateful render/transport
closures extract after (Stage 1+).

## Status

- **Stage 0a — DONE** (`features/branding/emoji.ts`): the 3 emoji maps,
  `EmojiEntity`/`ParsedText`, `extractBaseModel`. `tg` 1728 → 1622.
- **Stage 0b — DONE** (`features/branding/detect.ts`): `isProcessRunning`,
  `detectAgentViaAncestry`. `tg` 1622 → 1589.
- **Stage 0c — NEXT** (`features/cli/args.ts`): `parseArgs` + path helpers +
  `Item`/`ParseResult`/`Format`/`ItemLineSpec`. Bigger: `parseArgs` pulls in
  feature imports (`parseLineSpec`, `buildFileIndex`, `isRecursiveCandidate`,
  `looksPathLike`, `isNeverAttach`) and 5 test files import `parseArgs` from
  `../tg` (update to `../features/cli/args`). Mechanical but careful.
- **Stage 0d / 1 / 2** — version, render, transport (below).

All 579 `bun test` pass after Stages 0a-0b (zero behaviour change).

## Staging (each stage: extract → `bun test` 579 green → commit)

- **Stage 0** — pure top-level helpers: `features/cli/args.ts`,
  `features/cli/version.ts`, `features/branding/emoji.ts` (done),
  `features/branding/detect.ts` (done). No `main` state captured → mechanical
  move + import. Biggest, safest win (~500 lines out of `tg`).
- **Stage 1** — render: `features/render/html.ts` + `features/render/prefix.ts`
  (thread the branding/flags state as params).
- **Stage 2** — transport: `features/transport/telegram.ts` (thread token/chat/API
  + the routes recorder).
- **Stage 3** — `tg` is now thin wiring; add focused unit tests for the newly
  extracted pure modules (args, emoji, detect) that were previously only covered
  end-to-end.

## Non-goals

- No behaviour or output change; no new features; no dependency added.
- Not touching `tg-ctl` (already thin over `features/tg-ctl/`).
- The `feat-tg-photo-visual-hook` photo-hook (Stage 3 of the visual effort) is a
  separate branch; it re-applies its one `stat`-guarded pre-send call onto the
  decomposed `main` after this lands (small, vs. the heavy collision a parallel
  decomposition would have caused — which is why that agent deferred Stage 4).

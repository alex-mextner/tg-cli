# tg-cli — auto-attach feature spec (authoritative, CTO-confirmed)

Repo: `~/.files/repos/tg-cli` (Bun/TS single-file `tg`, tests in `tests/`). The deployed
binary `~/.files/bin/tg` is the same file (symlink/copy). Work in a branch, TDD, codex
review iterations, NOT merged.

## North star
The path/file auto-attach is a FEATURE (keep it). Make it robust + smart. Group ALL
extraction/attach logic into a `features/auto-attach` module. ON by default. Add a feature
toggle system: `~/.config/tg-cli/config.yaml` (`features: { auto-attach: true }`) overridable
by `--feature <name>` / `--no-feature <name>` CLI flags.

## CORE CORRECTION: never excise a path
Paths mentioned in text STAY in text. The current code excises the matched path token from
the caption — REMOVE that. Detected files get attached; the path stays as written.

## Rules (per detected path P → existing file F, and per inline pasted content)

- **R1** Path present → ATTACH F (photo if image ext, else document). Keep P in text.
- **R2** If F's **FULL** content is ALSO pasted in the message (duplicated verbatim) →
  REMOVE that duplicated content block from the text, keep P, attach F.
- **R3** Inline **excerpt** (a part of a file / a snippet) whose text **≤ 1024** chars →
  LEAVE inline as-is, and do NOT attach it.
- **R4** Inline excerpt / free code block **> 1024** chars → ATTACH it as a fragment file,
  clearly marked as a fragment, and remove it from the inline text.

## Line-spec extraction (answer A)
If a path carries a trailing location spec — `file.ts:42`, `file.ts:42-50`,
`file.ts:42:5` (line, line-range, line:col, column) — then IN ADDITION to attaching F:
- AST-aware extract the referenced location **±2 lines of context**, where the ±2 is also
  AST-aware (snap to statement/node boundaries, not blind line math). Where no parser is
  available for the language, degrade to a sensible line-based ±2.
- Re-indent the snippet with **minimal indentation** (shift-tab: strip the common leading
  whitespace so the quote isn't pushed right by its original nesting depth).
- Render in TG as a **quote with syntax highlighting** (`<pre><code class="language-XXX">`),
  indented 2 spaces, placed on the line **directly below** the path mention.
- The ATTACHED file copy gets a visible marker comment band around the referenced range:
  `// line: ------------------------------------` lines, so the location is easy to find in
  the attachment. ONLY in the copy sent to TG — NEVER modify the original file. Prefer an
  **in-memory FS simulation** over real disk copies; if a real copy is ever made, delete it.

## Caption overflow (answer 2)
Telegram caption limit = 1024. If the accompanying text for a photo/document > 1024 → send
the media with NO long caption (short/none) and send the full text as a SEPARATE text
message (handled under the hood).

## Message splitting (answer 3 / B)
Any TEXT message (original, or split-off from a caption) exceeding Telegram's 4096 limit →
split into multiple messages on SAFE boundaries: prefer newline/paragraph, never split
mid-HTML-tag (close+reopen formatting per chunk so each chunk is valid HTML) and never
mid-multibyte. The splitter is GENERIC: it runs LAST and knows nothing about excerpts.
Excerpt→file conversion (R4) happens earlier; whatever text remains, if > 4096, gets split.

## Ordering (answer D)
Send order is a sandwich: **photos → text → documents(files)**. Photos first, then the
text message(s), then file/document attachments.

## Filename inference for attached excerpts (answer C)
Excerpt-without-path (free large code/text > 1024) → attach as a fragment file too. Name:
if a sentence ending with `:` immediately precedes the excerpt, take its start as the
filename base; auto-detect the extension from content (language detection → .ts/.tsx/.js/
.py/.json/.md/.txt …). Mark as a fragment.

## Architecture (do it right, reliable)
1. `features/auto-attach/` — pure extraction: path+line-spec parsing, content-dup detection,
   excerpt detection, AST-aware snippet extraction + shift-tab, filename inference, marker
   injection (in-memory). No network here.
2. A single **pre-send normalization layer** that turns (raw text, explicit items) into an
   ordered **SendPlan**: `{ photos[], textMessages[], documents[] }` with ALL rules applied.
3. A generic **transmitter** that consumes the SendPlan: applies caption-overflow split and
   the >4096 message splitter, sends in the photos→text→files order. The transmitter is the
   ONLY place that talks to the Telegram API and the ONLY place length limits live.
4. **Feature flags**: load `~/.config/tg-cli/config.yaml` → `features.<name>`, override with
   `--feature`/`--no-feature`. `auto-attach` default ON. With auto-attach OFF, behavior =
   the old simple send (explicit --photo/--file only, no path scanning), still with the
   caption-overflow + splitting safety net (those are transmitter-level, not the feature).

## Tests (TDD, red-first)
- parseArgs: paths NOT excised; multiple paths; line-spec parse (`:N`, `:N-M`, `:N:C`).
- R2 full-dup strip; R3 ≤1024 inline-keep-no-attach; R4 >1024 → fragment file.
- AST-aware ±2 extraction + shift-tab + TG quote formatting; marker-comment injection in copy.
- caption > 1024 → separate text message.
- text > 4096 → HTML-safe split (tags balanced per chunk, multibyte intact).
- ordering photos→text→files.
- feature config.yaml + `--feature`/`--no-feature`; auto-attach default ON; OFF path.
- in-memory FS: no stray files left on disk.

## Out of scope / degrade honestly
- Full AST parsing for every language is not feasible in a single Bun script; use a light
  approach (brace/indent-aware ±2, or a small parser only for the common langs) and degrade
  to line-based ±2 otherwise — but say so in code comments + the spec, don't pretend.

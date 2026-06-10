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

## Size gate on PATH → attach (FIX 1, CTO-confirmed)

R1 ("path present → attach F") is reconciled with the 1024 size principle (R3/R4):
the attach decision for an AUTO-detected path is size-gated on the same 1024 constant.
The gate lives in the pure `features/auto-attach/line-spec.ts` (`planLineSpecs`,
injected content-reader, unit-tested) and is consumed by the `tg` send path.

- **Line-spec path** (`file.ts:N` / `:N-M` / `:N:C`): ALWAYS show the AST-aware ±2
  snippet inline (below the mention). Attach the FULL marker-injected file ONLY if its
  content **> 1024** chars. If the whole file **≤ 1024** → snippet inline ONLY, no
  attachment (the snippet is taken to show everything).
- **Bare path** (no line-spec), AUTO-detected: attach ONLY if content **> 1024** chars.
  If **≤ 1024** → keep the path mention in the text, do NOT attach and do NOT auto-inline
  the content (decision A: don't dump content the user didn't paste).
- **EXPLICIT `--photo`/`--file`** items are NEVER gated — a flag is a direct instruction;
  they always attach. An explicit `--file x.ts` that ADOPTS a text line-spec
  (`--file x.ts "see x.ts:3"`) still attaches with markers regardless of size.
- **PHOTOS** are never gated (a char count on binary image bytes is meaningless, and
  reading them as UTF-8 would corrupt the upload). **Binary / unknown-ext documents** and
  **unreadable** files fall through to ATTACH — when size can't be measured, err toward
  attaching, never silently drop a file.
- Interaction with R2: a doc the gate will DROP is excluded from R2 dup-stripping, so a
  small auto doc whose content was pasted keeps the paste (the attachment goes, the text
  stays). R2/R3/R4 are otherwise unchanged; the gate only adds the PATH→attach size check.

KNOWN LIMITATION (deferred — raised by codex, kept per the explicit ≤1024 rule): a small
but many-line line-spec file (≤1024 chars total but spanning more than the ±2 context
window) shows only the snippet, not the whole file — the other lines are omitted. This is
a deliberate consequence of the char-threshold rule as the CTO specified it. A span-aware
gate ("attach when ±2 doesn't cover the whole file even if ≤1024") would be a refinement if
the CTO wants it; not implemented here.

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

## Implementation notes (what actually shipped — read this)

Module layout (`features/auto-attach/`):
- `feature-flags.ts` — pure config.yaml parse (tiny hand-rolled reader, no yaml dep) +
  3-layer resolution (default → config → `--feature`/`--no-feature`). `auto-attach` ON by
  default.
- `types.ts` — `SendItem` (source = disk path OR in-memory `{filename, content}`),
  `SendPlan {photos, textMessages, documents}`, limits (`CAPTION_LIMIT=1024`, `MESSAGE_LIMIT=4096`).
- `extract.ts` — R2 (`stripDuplicatedFileContent`, line-based & whitespace-tolerant), R4
  (`extractLargeCodeBlocks`, >1024 fenced; ≤1024 left inline = R3), `detectLanguage`,
  `inferFragmentName`.
- `snippet.ts` — line-spec parse + AST-aware ±2 extraction + shift-tab + quote render +
  marker injection.
- `normalize.ts` — `extractFromText` (R4 spliced last-to-first, THEN R2) + `buildSendPlan`
  with a `renderText` hook (emoji rendering injected by tg so entity offsets are computed
  on post-extraction text).
- `transmitter.ts` — the ONLY layer with Telegram length-limit logic + ordering. Injectable
  `Transport` (mockable). Caption-overflow + the >4096 split are safety nets that run even
  when `auto-attach` is OFF.

AST-awareness is **honestly light** (not a real parser):
- ts/tsx/js/jsx/json/go/rs/css: brace-balance — after ±2 lines, extend outward (capped at
  40 lines) until `{`/`}` balance. Ignores braces inside strings/comments — acceptable for a
  preview snippet, NOT a correctness guarantee.
- py: indent-aware — extend to the contiguous block at/above the target line's indent.
- everything else: plain line-based ±2.
The column in `file.ts:N:C` is parsed and surfaced but not used to narrow the extraction.

Pipeline order (forced): `decode → extractFromText(R4 then R2) → renderText(prefix + emoji →
inline <tg-emoji> HTML) → insert line-spec quotes (post-render, token-anchored) → SendPlan →
transmit (caption-overflow → 4096 split → photos→text→documents)`.

HTML / escaping rule: custom-emoji entities are rendered to inline `<tg-emoji>` HTML up
front (so the splitter can't invalidate offset arrays). When HTML is forced ONLY to carry
emoji/quotes (no user-intended HTML), the surrounding plain prose is HTML-escaped (`&<>`);
when the user asked for `--format html` or wrote real tags, prose is left verbatim.

Resolved edge: when extraction empties the prose but attachments remain, the AI-emoji/tmux
prefix still rides as the caption (consistent with `tg --photo x.png`); a truly empty render
(no prefix, no prose) produces no text message.

In-memory FS: line-spec marker copies and R4 fragments are `Blob`s built from in-memory
content — the original files are never modified and nothing is written to disk (verified:
a real smoke send left the source hash unchanged with no stray files).

Multi-attachment albums (FIX 2, restored): multiple same-type attachments are sent as a
single `sendMediaGroup` album, NOT individual messages. The transmitter `sendMediaSection`
helper applies, per section:
- **≥2 items** → one `sendMediaGroup` call. Telegram caps a group at 10, so >10 same-type
  items are chunked into consecutive 10-item albums; a trailing chunk of exactly 1 falls
  back to `sendPhoto`/`sendDocument` (a 1-item group is rejected by the API).
- **exactly 1 item** → `sendPhoto`/`sendDocument` (you cannot build a 1-item album).
- **Photos and documents never share a group** (Telegram rejects mixed groups). The
  photo-album and the document-album are always separate calls — which the
  photos→text→documents ordering already separates.
- **Caption** rides only the FIRST item of the FIRST chunk of the host section (photos take
  caption priority over documents, matching single-item behavior). If the accompanying text
  > 1024 (visible length), the album is sent caption-less and the full text goes out as a
  SEPARATE text message in the sandwich middle (the existing caption-overflow path).
- The >4096 text splitter is unchanged and still runs only on text messages.

Line-spec limitations (deliberate, post-review):
- Snippet + marker injection apply only to a known-text extension allowlist (ts/tsx/js/py/
  json/md/sh/css/yaml/go/rs/txt/csv/log/toml/ini/xml/sql/etc.). A binary document with a
  trailing `:N` (e.g. `report.pdf:12`) still attaches as-is — no snippet, no marker copy —
  because reading it as UTF-8 would corrupt the upload.
- First line-spec per file wins. If the same file is referenced with two different specs
  (`x.ts:10 x.ts:20`), only the first drives the marker-injected attachment (a single copy
  can only mark one range). A spec mention of an already-attached file (e.g.
  `tg --file x.ts "see x.ts:42"`) adopts the spec onto that existing attachment.
- CSS markers use a full `/* line: … */` block comment (a bare `/*` would comment out the
  rest of the attached copy).

Length measurement: the caption-overflow decision (1024) uses an approximate VISIBLE length
(`visibleLength` strips HTML tags + unescapes entities), so an emoji prefix + ~1000 visible
chars rides as a caption instead of being wrongly split off. The >4096 splitter still
measures raw `.length` (it splits a hair earlier under HTML — benign conservatism, every
chunk stays valid).

## v1.2 amendments

### BOM-on-upload (encoding fix)

Text documents sent to Telegram were rendered with mojibake for non-ASCII content because
Telegram's preview heuristic guessed a legacy codepage for BOM-less UTF-8 files. v1.2 fixes
this by prepending a UTF-8 BOM (`\xEF\xBB\xBF`) to the **uploaded copy only** — the file on
disk is never modified.

Rules:
- Applied to a **whitelist** of prose/code extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`,
  `.cjs`, `.py`, `.rb`, `.go`, `.rs`, `.md`, `.markdown`, `.txt`, `.csv`, `.log`, `.yaml`,
  `.yml`, `.toml`, `.ini`, `.xml`, `.sql`, `.css`, `.html`, `.htm`, `.vue`, `.svelte`.
- **Deliberately excluded**: `.sh` (BOM breaks shebangs) and `.json` (BOM breaks
  `JSON.parse` in every standard parser).
- Pre-conditions: the uploaded bytes must be valid UTF-8, contain at least one non-ASCII
  byte, and must not already start with a BOM. Files that fail these checks are uploaded
  verbatim.
- Size cap: 2 MB. Files above the cap skip BOM injection and upload as-is.
- Module: `features/auto-attach/encoding.ts`.

### Extensionless file gate

Auto-detected files whose name carries no recognizable extension — `LICENSE`, `Makefile`,
`tg`, dotfiles such as `.env`, `.gitignore`, binaries, etc. — are **not attached** when
detected from path-scanning. The path token stays in the message text.

Rationale: extensionless names are almost always plain-text prose or scripts; attaching them
without a user signal produces more noise than value, and type-inference on them is
unreliable.

Exception: **explicit flags always attach**. `--file LICENSE` or `--photo somefile`
unconditionally attaches the named file regardless of extension (or lack thereof). An
explicit flag is a direct instruction.

Implementation: `hasRealExtension(name)` helper in `parseArgs`; returns `false` for names
with no dot or only a leading dot (dotfiles). The size-gate and R1–R4 rules apply normally
once the extensionless gate is passed (i.e. the gate is a pre-check, not a replacement for
the existing path-matching logic).

### Never-attach denylist (v1.3)

Files whose BASENAME matches a secrets-focused pattern list are never attached, whatever
the user typed (`attach-denylist` feature, ON by default; patterns in
`features/auto-attach/denylist.ts`):

- dotenv family: `.env`, `.env.*`, `*.env`;
- SSH private keys: `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519` (`.pub` stays allowed);
- key material: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`;
- credential rc-files: `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.htpasswd`,
  `.pgpass`, `.my.cnf`;
- shell/REPL histories (`.*_history`), `*.tfvars`, `credentials(.json)`,
  `client_secret*.json`, `kubeconfig`.

Semantics differ from the extensionless gate on purpose:

- auto-detected mention → silently skipped, token stays in the text;
- explicit `--photo`/`--file` → **hard error** before anything is sent. An explicit
  secret attach is almost certainly a mistake or a leak; a silent skip would hide it.

Override consciously with `--no-feature attach-denylist` or
`features.attach-denylist: false` in `~/.config/tg-cli/config.yaml`. Matching is
basename-only so a file living in a directory named `.env/` is not blocked.

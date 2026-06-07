# Custom Emoji System

## Overview

The `tg` CLI supports custom emoji icons for AI model identification in Telegram messages. The system uses Telegram's custom emoji sticker sets (`custom_emoji` type) to display model-specific icons instead of generic Unicode emojis.

## How it works

1. The bot `@HyperIDE_Bot` owns custom emoji sticker sets
2. Each sticker has a `custom_emoji_id` (19-digit numeric string)
3. The `tg` CLI maps model names to these IDs
4. When sending a message, the CLI creates `custom_emoji` entities in the Telegram API payload
5. The resulting message shows the custom icon instead of (or alongside) Unicode fallback

## Current set

- **Set name**: `agents_by_HyperIDE_Bot`
- **URL**: https://t.me/addemoji/agents_by_HyperIDE_Bot
- **Bot**: `@HyperIDE_Bot`

## Model to Emoji mapping

| Model | Emoji | Custom Emoji ID | Notes |
|-------|-------|-----------------|-------|
| HyperIDE | 🚁 | `5274191514178723918` | |
| Claude | ✳️ | `5274170649227600531` | Also anthropic, devin, cognition, aider, continue |
| Codex / OpenAI | 👐 | `5273797309195393626` | Also o3, o1, gpt4, gpt3, gpt |
| Gemini | ♊️ | `5274254027427716477` | Also google |
| DeepSeek | 🐳 | `5274018976752511967` | |
| Qwen | 🟣 | `5274109179655661197` | Also alibaba |
| Kimi | 🌙 | `5273889053991805596` | Also moonshot. Any version (kimi-k2p6-turbo) matches |
| Mistral | Ⓜ️ | `5273823740424134905` | |
| Grok | 🤘 | `5273973737861981852` | Also xai |
| Copilot | 🦾 | `5274136375388580049` | Also github |
| Perplexity | 🔮 | `5273733846758631156` | |
| Cursor | 👆 | `5273731871073672487` | |
| Windsurf | 🏄 | `5273875761068025296` | |
| Meta / Llama | 🦙 | `5274259902942977093` | |
| Ollama | 🦙 | `5273886056104634966` | |

## Alias system

Multiple model names can share the same emoji ID. This is intentional — versions of the same model family share the same icon:

- `claude`, `anthropic`, `devin`, `cognition`, `aider`, `continue` → Claude's ✳️
- `codex`, `openai`, `o3`, `o1`, `gpt4`, `gpt3`, `gpt` → OpenAI's 👐
- `gemini`, `google` → Gemini's ♊️
- `kimi`, `moonshot`, `kimi-k2p6-turbo`, `kimi-k1.5` → Kimi's 🌙

## Agent / model detection

`detectAiModel()` picks the icon for the agent sending the message. Resolution order
(first match wins) — explicit signals MUST come before pgrep fallbacks:

1. `TG_AI_MODEL` env — explicit override, always wins.
2. **`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` env → `claude`.** Claude Code sets these in
   the agent environment. This check is deliberately ahead of the pgrep block: a
   background `ollama` daemon (common on macOS) matches `pgrep -x ollama` and otherwise
   mislabels a Claude Code session as ollama. (Regression covered by tests.)
3. `OPENCODE` env → read the model from `opencode debug config`.
4. `CODEX` env → `codex`.
5. pgrep fallbacks for `aider`, `cursor`, `windsurf`, `llama`, `ollama`, `opencode`.

Debug the result without sending a message: `tg --detect-model` prints `<model>\t<emoji>`.

## Version-agnostic detection

The `extractBaseModel()` function extracts the base model name from versioned identifiers:

- `kimi-k2p6-turbo` → `kimi`
- `claude-3-opus` → `claude`
- `gpt-4o` → `gpt`
- `o1-preview` → `o1`
- `accounts/fireworks/routers/kimi-k2p6-turbo` → `kimi-k2p6-turbo` → `kimi`

This is done by:
1. Checking exact match in `MODEL_EMOJI_MAP` or `EMBEDDABLE_EMOJI_MAP`
2. If no exact match, split by `-` or `_` and try progressively shorter prefixes
3. First matching prefix wins

## Icon design requirements

### SVG source files

All icons are sourced from [svgl](https://svgl.app/) or similar icon repositories. The original SVGs are preserved in `/tmp/hi_v2/clean/`.

### Processing rules

**White circle background (for icons that need to be visible on dark backgrounds):**
- Apply when the icon has no natural background or is hard to see on dark backgrounds
- Circle: `cx="50" cy="50" r="48" fill="white"`
- Centered in 100x100 canvas

**White stroke (for icons that need outline definition):**
- Apply when the icon is a simple shape or line art
- Stroke: `stroke="white" stroke-width="2"`
- Shrink content by 4px and center to make room for stroke

**Auto-centering:**
- Calculate bounding box of all paths in the SVG
- Scale to fit within 80x80 (leaving 10px margin)
- Center using `translate(tx, ty) scale(s)`

### SVG sources

**All SVG sources live in the repo under `emoji-icons/src/<model>.svg`.** Never re-download
ad hoc — the committed SVG is the single source of truth. Original upstream URLs (for
re-fetching if an icon needs updating):

| Model | Upstream source | Notes |
|-------|-----------------|-------|
| Claude | https://svgl.app/library/anthropic | |
| Codex | https://svgl.app/library/openai | OpenAI flower mark (= ChatGPT). Rendered on a white circle. |
| Gemini | https://svgl.app/library/gemini | |
| DeepSeek | https://svgl.app/library/deepseek | |
| Kimi | https://svgl.app/library/kimi | |
| Mistral | https://svgl.app/library/mistral | |
| Meta/Llama | https://svgl.app/library/meta | |
| Perplexity | https://svgl.app/library/perplexity | |
| Grok | https://svgl.app/library/grok | |
| Copilot | https://svgl.app/library/github-copilot | |
| Windsurf | https://svgl.app/library/windsurf | |
| Cursor | https://svgl.app/library/cursor | |
| Qwen | https://svgl.app/library/qwen | |
| Ollama | https://svgl.app/library/ollama | |
| HyperIDE | https://github.com/hyperide/hyper-ext/blob/main/vscode-extension/hypercanvas-preview/media/preview.svg | Uses `currentColor` → script substitutes `stroke="black"` (black H on a white disc) |

### Per-model rules

Treatment is declared in `CONFIG` inside `scripts/build-emoji-icons.py` and applied
programmatically — do NOT bake circles/strokes into the source SVGs.

- **circle**: solid white disc behind the icon (for dark/low-contrast marks).
- **contour**: white silhouette traced around the icon's shape — an outline that follows
  the actual contour, NOT a surrounding circle. Used for dark icons that should keep their
  shape readable on a dark background.
- **none**: icon as-is on transparency (already visible on dark).

| Model | Background | `scale` | Notes |
|-------|-----------|---------|-------|
| Claude | none | 0.82 | Already visible on dark |
| Codex | circle | 0.60 | OpenAI flower on white disc |
| Copilot | circle | 0.60 | |
| Ollama | circle | 0.56 | Smaller — was clipping at larger scale |
| Grok | circle | 0.60 | Dark mark on white disc |
| Perplexity | circle | 0.60 | Dark teal mark on white disc |
| Windsurf | circle | 0.60 | Line-art W on white disc |
| HyperIDE | circle | 0.58 | Black H (`stroke="black"`) on white disc — stays legible on light AND dark Telegram themes |
| Cursor | contour | 0.74 | Dark mark, white silhouette outline |
| Qwen | contour | 0.74 | Purple fill `#7B3FF2` + white silhouette outline |
| Gemini | none | 0.82 | |
| DeepSeek | none | 0.82 | |
| Kimi | none | 0.82 | |
| Mistral | none | 0.82 | |
| Meta/Llama | none | 0.82 | |

`scale` = fraction of the cell the trimmed icon content occupies. Lower = more padding.
circle/contour icons sit smaller so the treatment has room. Icons are auto-trimmed
(transparent border removed) then scaled to fit, so nothing clips regardless of source
viewBox.

The white disc is drawn with anti-aliasing (4× supersample + LANCZOS downscale) — a 1×
`ImageDraw.ellipse` produces a jagged staircase edge that looks pixelated in Telegram.

**Verify on both themes:** `--preview` renders a dark-bg collage, `--preview-light` a
light-bg one. Any icon relying on a white disc or white stroke MUST be checked on the
light preview — white-on-white vanishes (this is why HyperIDE moved from `stroke="white"`
to a black H on a white disc).

## Build pipeline

The build is fully scripted — `scripts/build-emoji-icons.py`:

```bash
# Render all icons at 100×100 (Telegram custom emoji size)
python3 scripts/build-emoji-icons.py --size 100

# Preview only (no file writes) + dark-bg collage for review
python3 scripts/build-emoji-icons.py --no-write --preview /tmp/preview.png

# Rebuild a subset
python3 scripts/build-emoji-icons.py --only codex,ollama
```

Per icon the script: renders `src/<model>.svg` via `rsvg-convert` at 512px → auto-trims
transparent borders → scales to `scale*size` with centered padding → applies the `bg`
treatment (circle / contour / none) → writes `<prefix><model>.png` at `--size`.

Output filenames default to the `mini_` prefix (matching the committed repo assets). The
upload scripts (`create-ai-emoji-set.py` / `.ts`) expect bare `<model>.png`, so generate
upload assets into a temp dir with `--prefix ''`:

```bash
python3 scripts/build-emoji-icons.py --size 100 --prefix '' --out /tmp/upload
python3 scripts/create-ai-emoji-set.py --image-dir /tmp/upload
```

A missing `src/<model>.svg` for any configured model is a fatal error (the script exits
non-zero before rendering) — generated assets never go stale silently.

### Mandatory review workflow (do this every time, no exceptions)

1. **Render** both previews:
   `build-emoji-icons.py --no-write --preview /tmp/dark.png --preview-light /tmp/light.png`
   Check icons on BOTH — white discs/strokes can vanish on the light theme.
2. **Run `review` CLI** on the working-tree diff (`review` in the repo root) BEFORE sending
   anything. Fix every finding.
3. **Fix** issues, re-render, re-review until clean.
4. **Only then send the preview to Telegram** for human approval. Never send an unreviewed
   preview.
5. After approval: write `mini_*.png` (`build-emoji-icons.py --size 100`), generate upload
   assets (`--prefix '' --out /tmp/upload`), upload via `create-ai-emoji-set.py`, update IDs
   in `tg` from the printed mapping.

### Bot API note (createNewStickerSet)

Bot API 6.6+ takes `stickers` as a JSON array of InputSticker objects
(`{sticker: "attach://fileN", format: "static", emoji_list: [emoji]}`) with files attached
via multipart `attach://` — NOT the old single-`sticker`+`emojis` form (that returns
"there is no sticker file in the request"). The owner `user_id` must have interacted with
the bot at least once (send `/start`), else `createNewStickerSet` returns "user not found".

Every new requirement the user states about icon treatment MUST be recorded in this spec
(the `CONFIG` table above) — the spec is the contract, not chat history.

## Environment variable overrides

Users can override emoji IDs without modifying the source:

```bash
# Override single model
TG_EMOJI_ID_claude=1234567890123456789 tg "message"

# Override multiple models
TG_EMOJI_IDS='{"claude":"123","codex":"456"}' tg "message"
```

Validation:
- IDs must be exactly 19 digits (`/^\d{19}$/`)
- Invalid IDs are rejected with a warning to stderr
- Empty strings are rejected
- Arrays and non-object JSON are rejected
- Prototype pollution keys (`__proto__`, `constructor`, `toString`, `valueOf`) are blocked

## HTML and Custom Emoji

Telegram Bot API does not allow `entities` and `parse_mode` simultaneously. The `tg` CLI handles this automatically:

- **Without `--format html`**: Uses `entities` (custom emoji works, HTML tags in text are sent as plain text)
- **With `--format html`**: Uses `parse_mode=HTML` and converts custom emoji entities to `<tg-emoji>` tags in the text
- **Auto-detection**: If `--format` is omitted but text contains HTML tags (`<b>`, `<i>`, etc.), `parse_mode=HTML` is used automatically

Example with `--format html`:
```
tg --format html "<b>Hello</b> :kimi:"
```

The `:kimi:` helper is converted to `<tg-emoji emoji-id="5269705184614850043">🌙</tg-emoji>` in the text, and `parse_mode=HTML` is set. Telegram renders both the bold text and the custom emoji.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Model Name    │────▶│  extractBaseModel │────▶│  MODEL_EMOJI_MAP │
│  (kimi-k2p6)    │     │  (kimi-k2p6 → kimi)│     │  (kimi → 🌙)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          │
                               ┌─────────────────────────┘
                               ▼
                      ┌─────────────────┐
                      │  EMBEDDABLE_MAP │
                      │ (kimi → ID)     │
                      └─────────────────┘
                               │
                               ▼
                      ┌─────────────────┐
                      │ Telegram API    │
                      │ custom_emoji    │
                      │ entity          │
                      └─────────────────┘
```

## Testing

Run tests:
```bash
bun test
```

Tests cover:
- Map structure and format validation
- Alias consistency (all aliases share same ID)
- Golden mapping for v10 IDs
- Unicode fallback coverage
- Help text consistency
- Environment variable overrides
- Invalid input rejection
- Security (prototype pollution prevention)
- Boundary tests (19-digit ID validation)

## Maintenance

When updating emoji sets (v10 → v11):
1. Update the `V10_GOLDEN_MAP` in tests (or remove it if using dynamic validation)
2. Update all `custom_emoji_id` values in `EMBEDDABLE_EMOJI_MAP`
3. Update the set URL comment
4. Run `bun test` to verify
5. Update `.files` submodule

## Adding a new model

1. Add entry to `EMBEDDABLE_EMOJI_MAP` with the custom emoji ID
2. Add entry to `UNICODE_EMOJI_MAP` with the Unicode fallback
3. Add entry to `MODEL_EMOJI_MAP` with the display emoji
4. Add to help text if user-facing
5. Add test in `tests/emoji_map.test.ts`
6. If it's an alias, add to the appropriate alias group test

## Files

- `tg` — Main CLI script with all emoji logic
- `tests/emoji_map.test.ts` — 48 tests covering the system
- `package.json` — Test script and module configuration
- `docs/custom-emoji-system.md` — This document

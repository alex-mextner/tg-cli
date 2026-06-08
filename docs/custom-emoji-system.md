# Custom Emoji System

## Overview

The `tg` CLI shows a per-agent icon in Telegram messages using Telegram's custom emoji
sticker sets (`custom_emoji` type) instead of generic Unicode emojis. Each AI model/agent
maps to a `custom_emoji_id` in a set owned by a bot.

## How it works

1. The bot `@HyperIDE_Bot` owns the custom emoji sticker set.
2. Each sticker has a `custom_emoji_id` (19-digit numeric string).
3. The `tg` CLI maps model names to these IDs (`EMBEDDABLE_EMOJI_MAP` in `tg`).
4. When sending, the CLI emits `custom_emoji` entities (or `<tg-emoji>` tags in HTML mode).
5. Telegram renders the custom icon, falling back to a Unicode emoji where unsupported.

## Current set

- **Set name**: `agents_by_HyperIDE_Bot`
- **Title**: `HyperIDE.ai · AI Agents`
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

Multiple model names can share the same emoji ID. This is intentional — versions of the
same model family share one icon:

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
This is an info-only flag and works without Telegram credentials configured.

## Version-agnostic detection

`extractBaseModel()` extracts the base model name from versioned identifiers:

- `kimi-k2p6-turbo` → `kimi`
- `claude-3-opus` → `claude`
- `gpt-4o` → `gpt`
- `o1-preview` → `o1`
- `accounts/fireworks/routers/kimi-k2p6-turbo` → `kimi-k2p6-turbo` → `kimi`

How:
1. Check exact match in `MODEL_EMOJI_MAP` or `EMBEDDABLE_EMOJI_MAP`.
2. If no exact match, split by `-` or `_` and try progressively shorter prefixes.
3. First matching prefix wins.

## Icon assets

### SVG sources

**All SVG sources live in the repo under `emoji-icons/src/<model>.svg`** — the committed
SVG is the single source of truth. Never re-download ad hoc. Upstream URLs below are only
for re-fetching when an icon genuinely needs updating.

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

### Per-model treatment

Treatment is declared in `CONFIG` inside `scripts/build-emoji-icons.py` and applied
programmatically — do NOT bake circles/strokes into the source SVGs.

- **circle**: solid white disc behind the icon (for dark/low-contrast marks). Drawn with
  anti-aliasing (4× supersample + LANCZOS downscale) — a 1× `ImageDraw.ellipse` produces a
  jagged staircase edge that looks pixelated in Telegram.
- **contour**: white silhouette traced around the icon's shape — an outline following the
  actual contour, NOT a surrounding circle. For dark icons that should keep their shape
  readable on a dark background.
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
| HyperIDE | circle | 0.58 | Black H (`stroke="black"`) on white disc — legible on light AND dark themes |
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
viewBox. Optional per-model `stroke` / `fill` keys substitute `currentColor` in the SVG.

## Build pipeline

Fully scripted — `scripts/build-emoji-icons.py`:

```bash
# Render all icons at 100×100 (Telegram custom emoji size) into emoji-icons/mini_*.png
python3 scripts/build-emoji-icons.py --size 100

# Preview only (no writes): dark + light collages for review
python3 scripts/build-emoji-icons.py --no-write --preview /tmp/dark.png --preview-light /tmp/light.png

# Rebuild a subset
python3 scripts/build-emoji-icons.py --only codex,ollama
```

Per icon: render `src/<model>.svg` via `rsvg-convert` at 512px → auto-trim transparent
borders → scale to `scale*size` with centered padding → apply the `bg` treatment
(circle / contour / none) → write `<prefix><model>.png` at `--size`.

Output filenames default to the `mini_` prefix (matching the committed repo assets). The
upload scripts expect bare `<model>.png`, so generate upload assets with `--prefix ''`:

```bash
python3 scripts/build-emoji-icons.py --size 100 --prefix '' --out /tmp/upload
```

A missing `src/<model>.svg` for any configured model is a fatal error (the script exits
non-zero before rendering) — generated assets never go stale silently.

### Mandatory review workflow (every time, no exceptions)

1. **Render** both previews:
   `build-emoji-icons.py --no-write --preview /tmp/dark.png --preview-light /tmp/light.png`
   Check icons on BOTH — white discs/strokes can vanish on the light theme (this is why
   HyperIDE moved from `stroke="white"` to a black H on a white disc).
2. **Run `review` CLI** on the working-tree diff (`review` in the repo root) BEFORE sending
   anything. Fix every finding.
3. **Fix** issues, re-render, re-review until clean.
4. **Only then send the preview to Telegram** for human approval. Never send an unreviewed
   preview.
5. After approval: regenerate `mini_*.png`, upload (below), update IDs in `tg`.

Every new requirement the user states about icon treatment MUST be recorded in this spec
(the `CONFIG` table above) — the spec is the contract, not chat history.

## Uploading / replacing the set

The uploader (`scripts/create-ai-emoji-set.py`, or the `.ts` equivalent) reads
`<model>.png` from `--image-dir`, creates the set, and prints the `model → custom_emoji_id`
mapping. `AI_MODELS` (uploader) MUST stay in sync with `CONFIG` (builder) and
`MODEL_EMOJI_MAP` (`tg`).

```bash
# 1. Generate upload assets
python3 scripts/build-emoji-icons.py --size 100 --prefix '' --out /tmp/upload

# 2. (Replacing an existing set) delete it first — frees the name so the URL is preserved
curl -s "https://api.telegram.org/bot$TG_BOT_TOKEN/deleteStickerSet" -d "name=agents_by_HyperIDE_Bot"

# 3. Create the set and capture the printed IDs
TG_BOT_TOKEN=... TG_OWNER_ID=<your-user-id> \
  python3 scripts/create-ai-emoji-set.py --image-dir /tmp/upload

# 4. Paste the new IDs into EMBEDDABLE_EMOJI_MAP in tg, then `bun test`
```

### Telegram Bot API gotchas

- **InputSticker format (6.6+):** `createNewStickerSet` takes `stickers` as a JSON array of
  InputSticker objects (`{sticker: "attach://fileN", format: "static", emoji_list: [emoji]}`)
  with files attached via multipart `attach://`. The old single-`sticker`+`emojis` form
  returns `"there is no sticker file in the request"`.
- **Owner must /start the bot:** `user_id` must have interacted with the bot at least once,
  else `createNewStickerSet` returns `"user not found"`. In a private chat, `TG_CHAT_ID`
  equals the owner's `user_id`.
- **Title:** set via `setStickerSetTitle` (no recreate needed); `name`/URL are immutable.
- **No list API:** Bot API cannot enumerate a bot's sets. To delete old ones you must know
  each name and hold the owning bot's token (`deleteStickerSet` per name).

## Environment variable overrides

Override emoji IDs without touching source:

```bash
# Single model
TG_EMOJI_ID_claude=1234567890123456789 tg "message"

# Multiple models
TG_EMOJI_IDS='{"claude":"123...","codex":"456..."}' tg "message"
```

Validation:
- IDs must be exactly 19 digits (`/^\d{19}$/`).
- Invalid IDs / empty strings / arrays / non-object JSON are rejected with a stderr warning.
- Prototype-pollution keys (`__proto__`, `constructor`, `toString`, `valueOf`) are blocked.

## HTML and Custom Emoji

Telegram Bot API does not allow `entities` and `parse_mode` simultaneously. `tg` handles
this automatically:

- **Without `--format html`**: uses `entities` (custom emoji works; HTML tags in text are
  sent as plain text).
- **With `--format html`**: uses `parse_mode=HTML` and converts custom emoji entities to
  `<tg-emoji>` tags in the text.
- **Auto-detection**: if `--format` is omitted but the text contains HTML tags, HTML mode
  is used automatically.

```
tg --format html "<b>Hello</b> :kimi:"
```

The `:kimi:` helper becomes `<tg-emoji emoji-id="5273889053991805596">🌙</tg-emoji>` and
`parse_mode=HTML` is set.

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

```bash
bun test
```

Covers: map structure & 19-digit ID format, alias consistency, Unicode fallback coverage,
help-text consistency, env-var overrides, invalid-input rejection, prototype-pollution
prevention, and agent detection (incl. a fake-`pgrep` regression proving `CLAUDECODE` beats
a running ollama). Tests parse `EMBEDDABLE_EMOJI_MAP` dynamically from `tg`, so updating IDs
does not require editing hardcoded golden values.

## Adding a new model

1. Add `emoji-icons/src/<model>.svg`.
2. Add a `CONFIG` entry in `scripts/build-emoji-icons.py` (bg / scale / optional stroke/fill).
3. Add the model to `AI_MODELS` in both `create-ai-emoji-set.py` and `.ts`.
4. Rebuild + re-upload the set, then add the new `custom_emoji_id` to `EMBEDDABLE_EMOJI_MAP`,
   `UNICODE_EMOJI_MAP`, and `MODEL_EMOJI_MAP` in `tg`.
5. Add to the help text if user-facing.
6. Add/extend tests in `tests/emoji_map.test.ts` (and the alias group test if it's an alias).

## Updating the set (e.g. icon redesign)

1. Edit `CONFIG` / source SVGs.
2. Run the mandatory review workflow above (dual-theme preview + `review` CLI).
3. Delete + recreate the set (preserves the `agents_by_HyperIDE_Bot` name/URL).
4. Replace all IDs in `EMBEDDABLE_EMOJI_MAP` and any hardcoded test IDs; `bun test`.
5. Commit (the `.files` repo is consumed as a submodule elsewhere).

## Files

- `tg` — main CLI with all emoji + detection logic.
- `emoji-icons/src/*.svg` — source SVGs (single source of truth).
- `emoji-icons/mini_*.png` — generated 100×100 assets.
- `scripts/build-emoji-icons.py` — SVG → PNG build pipeline.
- `scripts/create-ai-emoji-set.py` / `.ts` — sticker-set uploader.
- `tests/emoji_map.test.ts` — test suite.
- `docs/custom-emoji-system.md` — this document.

# Custom Emoji System

## Overview

The `tg` CLI supports custom emoji icons for AI model identification in Telegram messages. The system uses Telegram's custom emoji sticker sets (`custom_emoji` type) to display model-specific icons instead of generic Unicode emojis.

## How it works

1. The bot `@UltraClaudeCodeBot` owns custom emoji sticker sets
2. Each sticker has a `custom_emoji_id` (19-digit numeric string)
3. The `tg` CLI maps model names to these IDs
4. When sending a message, the CLI creates `custom_emoji` entities in the Telegram API payload
5. The resulting message shows the custom icon instead of (or alongside) Unicode fallback

## Current set

- **Set name**: `agents_v10_by_UltraClaudeCodeBot`
- **URL**: https://t.me/addemoji/agents_v10_by_UltraClaudeCodeBot
- **Bot**: `@UltraClaudeCodeBot`

## Model to Emoji mapping

| Model | Emoji | Custom Emoji ID | Notes |
|-------|-------|-----------------|-------|
| HyperIDE | 🚁 | `5269756337675346446` | |
| Claude | ✳️ | `5271533015321842500` | Also anthropic, devin, cognition, aider, continue |
| Codex / OpenAI | 👐 | `5269267767965556041` | Also o3, o1, gpt4, gpt3, gpt |
| Gemini | ♊️ | `5271619099351358220` | Also google |
| DeepSeek | 🐳 | `5271683223213087502` | |
| Qwen | 🟣 | `5271783192871870913` | Also alibaba |
| Kimi | 🌙 | `5269705184614850043` | Also moonshot. Any version (kimi-k2p6-turbo) matches |
| Mistral | Ⓜ️ | `5271760476789841127` | |
| Grok | 🤘 | `5271696550496611333` | Also xai |
| Copilot | 🦾 | `5271673589601443183` | Also github |
| Perplexity | 🔮 | `5269534987945814166` | |
| Cursor | 👆 | `5271670853707276208` | |
| Windsurf | 🏄 | `5269760727131924567` | |
| Meta / Llama | 🦙 | `5271674856616794663` | |
| Ollama | 🦙 | `5271946500413365403` | |

## Alias system

Multiple model names can share the same emoji ID. This is intentional — versions of the same model family share the same icon:

- `claude`, `anthropic`, `devin`, `cognition`, `aider`, `continue` → Claude's ✳️
- `codex`, `openai`, `o3`, `o1`, `gpt4`, `gpt3`, `gpt` → OpenAI's 👐
- `gemini`, `google` → Gemini's ♊️
- `kimi`, `moonshot`, `kimi-k2p6-turbo`, `kimi-k1.5` → Kimi's 🌙

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

### Per-model rules

| Model | Processing | Background | Stroke | Notes |
|-------|-----------|------------|--------|-------|
| Claude | Copy as-is | No | No | Already visible on dark |
| Codex | Copy as-is | No | No | Already visible on dark |
| Gemini | Copy as-is | No | No | Already visible on dark |
| DeepSeek | Copy as-is | No | No | Already visible on dark |
| Kimi | Copy as-is | No | No | Already visible on dark |
| Mistral | Copy as-is | No | No | Already visible on dark |
| Meta/Llama | Copy as-is | No | No | Already visible on dark |
| Perplexity | Copy as-is | No | No | Already visible on dark |
| Grok | White circle + center | Yes | Yes | Needs visibility on dark |
| Copilot | White circle + center | Yes | Yes | Needs visibility on dark |
| Windsurf | White circle + center | Yes | Yes | Needs visibility on dark |
| Cursor | White circle + center | Yes | Yes | Needs visibility on dark |
| Qwen | Purple fill `#7B3FF2` | No | No | Was black, changed to purple |
| Ollama | White circle, auto-center | Yes | No | Large paths, needs centering |
| HyperIDE | Original 512×512 viewBox | No | No | Preserve original aspect ratio |

## Build pipeline

1. **Copy untouched icons** from previous version (v9 → v10): claude, codex, gemini, deepseek, perplexity, kimi, mistral, meta
2. **Fix specific icons**:
   - Qwen: purple fill instead of black
   - HyperIDE: restore original 512×512 viewBox
   - Ollama: auto-center using bounding box calculation
   - Grok/Copilot/Windsurf/Cursor: preserve original viewBox, add white stroke, shrink 4px, center
3. **Generate PNG** via `rsvg-convert` (100×100)
4. **Create preview collage** for visual verification
5. **Upload to Telegram** via `createNewStickerSet` with `sticker_type=custom_emoji`
6. **Update IDs** in `tg` CLI source

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

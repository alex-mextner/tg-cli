#!/usr/bin/env python3
"""Create a Telegram custom emoji sticker set for AI model icons.

Usage:
    export TG_BOT_TOKEN="your_bot_token"
    python3 create-ai-emoji-set.py --image-dir ./ai-icons/

The image directory should contain PNG/WebP files named after the model:
    claude.png, codex.png, gemini.png, deepseek.png, qwen.png, kimi.png, glm.png

Each image should be 512x512 (or 100x100 for static emoji) and under 512KB.
"""

import os
import sys
import json
import argparse
from pathlib import Path
from typing import Optional

# AI model → emoji association mapping. The emoji is the Unicode char users
# type to get the custom emoji in Telegram. MUST stay in sync with the builder
# CONFIG in build-emoji-icons.py and MODEL_EMOJI_MAP in `tg` — every model here
# must have a generated <model>.png from the builder.
AI_MODELS = {
    "claude": "✳️",
    "codex": "👐",
    "copilot": "🦾",
    "cursor": "👆",
    "deepseek": "🐳",
    "gemini": "♊️",
    "grok": "🤘",
    "hyperide": "🚁",
    "kimi": "🌙",
    "meta": "🦙",
    "mistral": "Ⓜ️",
    "ollama": "🦙",
    "perplexity": "🔮",
    "qwen": "🟣",
    "windsurf": "🏄",
}

# Set name must be unique and end with "_by_<bot_username>"
SET_NAME = "agents"
SET_TITLE = "AI Agents"


def create_sticker_set(bot_token: str, image_dir: Path, dry_run: bool = False) -> None:
    """Create the custom emoji sticker set via Telegram Bot API."""
    import requests

    bot_username = get_bot_username(bot_token)
    set_name = f"{SET_NAME}_by_{bot_username}"

    # Preflight: every configured model MUST have an image. A partial upload
    # would create a broken set that looks successful, so fail loudly first.
    missing = [m for m in AI_MODELS if not (image_dir / f"{m}.png").exists()]

    if dry_run:
        print(f"[DRY RUN] Would create set: {set_name}")
        for model, emoji in AI_MODELS.items():
            img_path = image_dir / f"{model}.png"
            status = "" if img_path.exists() else " (MISSING)"
            print(f"  - {model}: {emoji} ({img_path}){status}")
        if missing:
            print(f"[DRY RUN] {len(missing)} image(s) missing: "
                  f"{', '.join(missing)}")
        return

    if missing:
        print(f"Error: missing image(s) for: {', '.join(missing)}")
        print(f"Generate them first: "
              f"build-emoji-icons.py --prefix '' --out {image_dir}")
        sys.exit(1)

    owner_id = get_owner_id(bot_token)
    models = list(AI_MODELS.keys())

    # Bot API 6.6+ createNewStickerSet: pass `stickers` as a JSON array of
    # InputSticker objects, each referencing an attached file via attach://.
    # Up to 50 stickers per call, so create the whole set in one request.
    files = {}
    input_stickers = []
    open_handles = []
    for i, model in enumerate(models):
        attach = f"file{i}"
        fh = open(image_dir / f"{model}.png", "rb")
        open_handles.append(fh)
        files[attach] = fh
        input_stickers.append({
            "sticker": f"attach://{attach}",
            "format": "static",
            "emoji_list": [AI_MODELS[model]],
        })

    url = f"https://api.telegram.org/bot{bot_token}/createNewStickerSet"
    data = {
        "user_id": owner_id,
        "name": set_name,
        "title": SET_TITLE,
        "sticker_type": "custom_emoji",
        "stickers": json.dumps(input_stickers),
    }
    try:
        resp = requests.post(url, data=data, files=files)
    finally:
        for fh in open_handles:
            fh.close()

    result = resp.json()
    if not result.get("ok"):
        print(f"Error creating set: {result}")
        sys.exit(1)

    print(f"Created set: {set_name} ({len(models)} stickers)")

    # Fetch the finished set and emit model -> custom_emoji_id mapping. Stickers
    # come back in insertion order, which matches AI_MODELS, so zip by index
    # (emoji is ambiguous — meta and ollama share 🦙).
    info_url = f"https://api.telegram.org/bot{bot_token}/getStickerSet"
    resp = requests.get(info_url, params={"name": set_name})
    data = resp.json()
    if not data.get("ok"):
        print(f"Warning: could not fetch set for IDs: {data}")
        return
    stickers = data["result"]["stickers"]
    models = list(AI_MODELS.keys())
    print(f"\nSet URL: https://t.me/addemoji/{set_name}")
    print("\nmodel -> custom_emoji_id:")
    mapping = {}
    for model, sticker in zip(models, stickers):
        cid = sticker.get("custom_emoji_id", "")
        mapping[model] = cid
        print(f"  {model}: {cid}")
    print("\nJSON:")
    print(json.dumps(mapping, indent=2))


def get_bot_username(token: str) -> str:
    """Get bot username from token."""
    import requests
    resp = requests.get(f"https://api.telegram.org/bot{token}/getMe")
    data = resp.json()
    if data.get("ok"):
        return data["result"]["username"]
    raise RuntimeError(f"Failed to get bot info: {data}")


def get_owner_id(token: str) -> int:
    """Get the owner ID (from env or prompt)."""
    owner_id = os.environ.get("TG_OWNER_ID")
    if owner_id:
        return int(owner_id)
    raise RuntimeError("Set TG_OWNER_ID env var to your Telegram user ID")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create AI model emoji sticker set")
    parser.add_argument("--image-dir", type=Path, required=True, help="Directory with PNG images")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done")
    args = parser.parse_args()

    token = os.environ.get("TG_BOT_TOKEN")
    if not token:
        print("Error: Set TG_BOT_TOKEN env var")
        sys.exit(1)

    create_sticker_set(token, args.image_dir, args.dry_run)


if __name__ == "__main__":
    main()

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

# AI model → emoji association mapping
# The emoji is what users type to get the custom emoji in Telegram
AI_MODELS = {
    "claude": "🤖",
    "codex": "👐",
    "gemini": "♊️",
    "deepseek": "🐳",
    "qwen": "🟣",
    "kimi": "🌙",
    "glm": "🗂",
    "gpt": "⚡",
    "openai": "⚡",
}

# Set name must be unique and end with "_by_<bot_username>"
SET_NAME = "ai_models_code"
SET_TITLE = "AI Models for Code"


def create_sticker_set(bot_token: str, image_dir: Path, dry_run: bool = False) -> None:
    """Create the custom emoji sticker set via Telegram Bot API."""
    import requests

    bot_username = get_bot_username(bot_token)
    set_name = f"{SET_NAME}_by_{bot_username}"

    if dry_run:
        print(f"[DRY RUN] Would create set: {set_name}")
        for model, emoji in AI_MODELS.items():
            img_path = image_dir / f"{model}.png"
            if img_path.exists():
                print(f"  - {model}: {emoji} ({img_path})")
            else:
                print(f"  - {model}: {emoji} (MISSING: {img_path})")
        return

    # Create the first sticker (required)
    first_model = list(AI_MODELS.keys())[0]
    first_emoji = AI_MODELS[first_model]
    first_img = image_dir / f"{first_model}.png"

    if not first_img.exists():
        print(f"Error: First image missing: {first_img}")
        sys.exit(1)

    # Create the set
    url = f"https://api.telegram.org/bot{bot_token}/createNewStickerSet"
    with open(first_img, "rb") as f:
        files = {"sticker": f}
        data = {
            "user_id": get_owner_id(bot_token),
            "name": set_name,
            "title": SET_TITLE,
            "emojis": first_emoji,
            "sticker_type": "custom_emoji",
        }
        resp = requests.post(url, data=data, files=files)

    result = resp.json()
    if not result.get("ok"):
        print(f"Error creating set: {result}")
        sys.exit(1)

    print(f"Created set: {set_name}")

    # Add remaining stickers
    for model, emoji in list(AI_MODELS.items())[1:]:
        img_path = image_dir / f"{model}.png"
        if not img_path.exists():
            print(f"  Skipping {model} (missing image)")
            continue

        add_url = f"https://api.telegram.org/bot{bot_token}/addStickerToSet"
        with open(img_path, "rb") as f:
            files = {"sticker": f}
            data = {
                "user_id": get_owner_id(bot_token),
                "name": set_name,
                "emojis": emoji,
            }
            resp = requests.post(add_url, data=data, files=files)

        result = resp.json()
        if result.get("ok"):
            print(f"  Added {model}: {emoji}")
        else:
            print(f"  Error adding {model}: {result}")


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

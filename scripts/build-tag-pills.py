#!/usr/bin/env python3
"""Build the tag-pill custom emoji: a native Telegram CHIP for each message tag
(ANSWER / DECISION / PROBLEM / REPORT), assembled from N square custom-emoji cells.

DESIGN
  Each pill is rendered ONCE at its natural (wide) aspect ratio:
    height = 1 cell (100px), width = N*100px, fully rounded ends, a saturated
    fill, and the English word baked in white bold. Then it is SLICED into N
    square 100x100 cells. Telegram packs custom emoji edge-to-edge horizontally,
    so the N cells re-stitch into one continuous chip in the message.

  This is the same machinery as the existing model emoji (emoji-icons/mini_*.png,
  100x100 RGBA) — a tag pill is just a wider glyph spread across 2-3 cells.

THEME-SAFE
  Saturated fill + white bold text = high contrast on BOTH dark and the CTO's
  light/green theme; the chip carries its own background, so it never depends on
  the bubble color. Transparent margin top/bottom = it floats like a real chip.
  Non-premium viewers see the unicode fallback (handled in features/render/tag.ts:
  TAG_PILL_FALLBACK, e.g. "🔵 ANSWER").

OUTPUT
  emoji-icons/tags/<tag>_<i>.png    the sliced cells to UPLOAD (i = 0..N-1)
  emoji-icons/tags/<tag>_full.png   the un-sliced chip (reference / preview only)

Requirements: rsvg-convert (brew install librsvg), Pillow.
"""
from __future__ import annotations

import subprocess
from io import BytesIO
from pathlib import Path

from PIL import Image

CELL = 100  # Telegram custom-emoji asset size (matches emoji-icons/mini_*.png)

# --- EDIT HERE — one entry per canonical (English) tag. fill = chip color,
# cells = how many 100px cells the word needs. All four canonical tags use 3
# cells so the rounded caps don't squish the 6-char words (ANSWER / REPORT);
# the wider chip gives the wordmark breathing room.
# Colors mirror the unicode TAG_PILL_FALLBACK dots in features/render/tag.ts
# (blue / amber / red / green). The `key` (lowercased canonical) is the file
# stem; it must match the keys the wiring loads in TAG_PILL_IDS / the upload
# script (scripts/create-tag-emoji.ts).
TAGS: dict[str, dict] = {
    "answer":   {"fill": "#2F86E0", "word": "ANSWER",   "cells": 3},  # 🔵 ANSWER
    "decision": {"fill": "#E8902B", "word": "DECISION", "cells": 3},  # 🟠 DECISION
    "problem":  {"fill": "#E0473B", "word": "PROBLEM",  "cells": 3},  # 🔴 PROBLEM
    "report":   {"fill": "#3BA55D", "word": "REPORT",   "cells": 3},  # 🟢 REPORT
}


def render_pill(fill: str, word: str, cells: int) -> Image.Image:
    """Render a rounded chip width=cells*CELL, height=CELL, word baked white."""
    w, h = cells * CELL, CELL
    pad_y = 9
    chip_h = h - pad_y * 2
    cr = chip_h / 2
    font_px = int(chip_h * 0.50)
    svg = f'''<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" \
xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="{pad_y}" width="{w - 6}" height="{chip_h}" rx="{cr}" ry="{cr}" \
fill="{fill}"/>
  <text x="{w / 2}" y="{h / 2 + 1}" font-family="Helvetica, Arial, sans-serif" \
font-weight="700" font-size="{font_px}" fill="#FFFFFF" text-anchor="middle" \
dominant-baseline="central" letter-spacing="1.5">{word}</text>
</svg>'''
    proc = subprocess.run(
        ["rsvg-convert", "-w", str(w), "-h", str(h)],
        input=svg.encode("utf-8"), capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"rsvg-convert failed for {word}: "
                           f"{proc.stderr.decode(errors='replace')}")
    return Image.open(BytesIO(proc.stdout)).convert("RGBA")


def main() -> int:
    out = Path(__file__).resolve().parent.parent / "emoji-icons" / "tags"
    # When run from /tmp, fall back to the repo path.
    if not out.parent.exists():
        out = Path("/Users/ultra/.files/repos/tg-cli/emoji-icons/tags")
    out.mkdir(parents=True, exist_ok=True)
    for key, t in TAGS.items():
        img = render_pill(t["fill"], t["word"], t["cells"])
        img.save(out / f"{key}_full.png")
        for i in range(t["cells"]):
            cell = img.crop((i * CELL, 0, (i + 1) * CELL, CELL))
            cell.save(out / f"{key}_{i}.png")
        print(f"  ok {key}: {t['cells']} cells  '{t['word']}'  -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

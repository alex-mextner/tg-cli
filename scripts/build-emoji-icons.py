#!/usr/bin/env python3
"""Build Telegram custom-emoji PNGs from SVG sources.

Pipeline per icon:
  1. Render src/<model>.svg to a large transparent RGBA bitmap (rsvg-convert).
  2. Auto-trim transparent borders, then scale to fit the cell with a margin
     (per-model `scale`), so every icon has consistent padding and nothing is
     clipped.
  3. Apply background treatment:
       - circle : solid white disc behind the icon
       - contour: white silhouette outline traced around the icon's shape
       - none   : icon as-is on transparency
  4. Save <out>/mini_<model>.png at the requested --size.

Also builds a dark-background preview collage for visual review.

Usage:
  python3 scripts/build-emoji-icons.py --size 100
  python3 scripts/build-emoji-icons.py --size 100 --preview /tmp/preview.png
  python3 scripts/build-emoji-icons.py --only codex,ollama

Requirements: rsvg-convert (brew install librsvg), Pillow.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# --- per-model build config -------------------------------------------------
# bg:      'circle' (white disc), 'contour' (white silhouette outline), 'none'
# scale:   fraction of the cell the icon content occupies (after auto-trim).
#          Lower = more padding / smaller icon. circle/contour icons sit
#          smaller so the treatment has room.
# stroke:  optional CSS color to substitute for `stroke="currentColor"` in the SVG.
# fill:    optional CSS color to substitute for `fill="currentColor"` in the SVG.
CONFIG: dict[str, dict] = {
    "claude":     {"bg": "none",    "scale": 0.82},
    "codex":      {"bg": "circle",  "scale": 0.60},
    "copilot":    {"bg": "circle",  "scale": 0.60},
    "cursor":     {"bg": "contour", "scale": 0.74},
    "deepseek":   {"bg": "none",    "scale": 0.82},
    "gemini":     {"bg": "none",    "scale": 0.82},
    "grok":       {"bg": "circle",  "scale": 0.60},
    "hyperide":   {"bg": "circle",  "scale": 0.58, "stroke": "black"},
    "kimi":       {"bg": "none",    "scale": 0.82},
    "meta":       {"bg": "none",    "scale": 0.82},
    "mistral":    {"bg": "none",    "scale": 0.82},
    "ollama":     {"bg": "circle",  "scale": 0.56},
    "perplexity": {"bg": "circle",  "scale": 0.60},
    "qwen":       {"bg": "contour", "scale": 0.74, "fill": "#7B3FF2"},
    "windsurf":   {"bg": "circle",  "scale": 0.60},
}

# Contour thickness as a fraction of the output size.
CONTOUR_FRAC = 0.06
RENDER_PX = 512  # high-res intermediate render before downscale


def render_svg(svg_path: Path, stroke: str | None,
               fill: str | None) -> Image.Image:
    """Render an SVG to a transparent RENDER_PX square RGBA bitmap."""
    data = svg_path.read_text(encoding="utf-8")
    if stroke:
        data = data.replace('stroke="currentColor"', f'stroke="{stroke}"')
    if fill:
        data = data.replace('fill="currentColor"', f'fill="{fill}"')
    proc = subprocess.run(
        ["rsvg-convert", "-w", str(RENDER_PX), "-h", str(RENDER_PX),
         "--keep-aspect-ratio"],
        input=data.encode("utf-8"),
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"rsvg-convert failed for {svg_path.name}: "
                           f"{proc.stderr.decode(errors='replace')}")
    from io import BytesIO
    return Image.open(BytesIO(proc.stdout)).convert("RGBA")


def fit_icon(img: Image.Image, size: int, scale: float) -> Image.Image:
    """Auto-trim transparent borders, scale to `scale*size`, center on canvas."""
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    inner = max(1, int(round(size * scale)))
    w, h = img.size
    ratio = min(inner / w, inner / h)
    nw, nh = max(1, int(round(w * ratio))), max(1, int(round(h * ratio)))
    img = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - nw) // 2, (size - nh) // 2), img)
    return canvas


def make_contour(icon: Image.Image, size: int) -> Image.Image:
    """White silhouette traced around the icon's alpha, behind the icon."""
    alpha = icon.split()[3]
    radius = max(1, int(round(size * CONTOUR_FRAC)))
    # MaxFilter kernel must be odd; expand the alpha outward.
    k = radius * 2 + 1
    grown = alpha.filter(ImageFilter.MaxFilter(min(k, 31)))
    if k > 31:  # very thick: dilate again
        grown = grown.filter(ImageFilter.MaxFilter(min(k, 31)))
    white = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    white.putalpha(grown)
    out = Image.alpha_composite(white, icon)
    return out


def make_circle(icon: Image.Image, size: int) -> Image.Image:
    """Solid white disc behind the icon, with an anti-aliased edge.

    PIL's ImageDraw has no native AA, so draw the disc on a 4x supersampled
    canvas and downscale with LANCZOS — that gives a smooth circle edge
    instead of the jagged staircase a 1x ellipse produces.
    """
    ss = 4
    big = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    ImageDraw.Draw(big).ellipse(
        [0, 0, size * ss - 1, size * ss - 1], fill=(255, 255, 255, 255))
    disc = big.resize((size, size), Image.LANCZOS)
    return Image.alpha_composite(disc, icon)


def build_icon(model: str, src_dir: Path, size: int) -> Image.Image:
    cfg = CONFIG[model]
    raw = render_svg(src_dir / f"{model}.svg", cfg.get("stroke"),
                     cfg.get("fill"))
    icon = fit_icon(raw, size, cfg["scale"])
    bg = cfg["bg"]
    if bg == "circle":
        return make_circle(icon, size)
    if bg == "contour":
        return make_contour(icon, size)
    return icon


def build_preview(icons: dict[str, Image.Image], out: Path,
                  bg=(18, 18, 18)) -> None:
    names = list(icons.keys())
    cell = next(iter(icons.values())).size[0]
    cols = 5
    rows = (len(names) + cols - 1) // cols
    pad, label_h, margin, title_h = 22, 22, 28, 48
    cw, ch = cell + pad * 2, cell + pad * 2 + label_h
    W = cols * cw + margin * 2
    H = rows * ch + margin * 2 + title_h
    canvas = Image.new("RGB", (W, H), bg)
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13)
        tfont = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 17)
    except OSError:
        font = tfont = ImageFont.load_default()
    # Pick legible text color for the background luminance.
    light_bg = sum(bg[:3]) / 3 > 128
    title_col = (40, 40, 40) if light_bg else (200, 200, 200)
    label_col = (90, 90, 90) if light_bg else (150, 150, 150)
    draw.text((W // 2, margin + 4), "tg-cli · AI emoji pack",
              font=tfont, fill=title_col, anchor="mm")
    for i, name in enumerate(names):
        col, row = i % cols, i // cols
        x = margin + col * cw + pad
        y = margin + title_h + row * ch + pad
        cell_bg = Image.new("RGBA", (cell, cell), (*bg, 255))
        cell_bg = Image.alpha_composite(cell_bg, icons[name])
        canvas.paste(cell_bg.convert("RGB"), (x, y))
        draw.text((x + cell // 2, y + cell + 6), name,
                  font=font, fill=label_col, anchor="mm")
    canvas.save(out, "PNG")


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    src_dir = repo / "emoji-icons" / "src"
    out_dir = repo / "emoji-icons"

    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=100,
                    help="output PNG size in px (Telegram custom emoji = 100)")
    ap.add_argument("--out", type=Path, default=out_dir)
    ap.add_argument("--only", default="",
                    help="comma-separated subset of models to build")
    ap.add_argument("--prefix", default="mini_",
                    help="output filename prefix. Default 'mini_' matches the "
                         "repo assets; pass --prefix '' to emit <model>.png for "
                         "the create-ai-emoji-set upload scripts")
    ap.add_argument("--preview", type=Path, default=None,
                    help="also write a dark-bg preview collage here")
    ap.add_argument("--preview-light", type=Path, default=None,
                    help="also write a light-bg preview collage here (verifies "
                         "icons stay legible on light Telegram themes)")
    ap.add_argument("--no-write", action="store_true",
                    help="build for preview only, do not write PNGs")
    args = ap.parse_args()

    only = {m.strip() for m in args.only.split(",") if m.strip()}
    unknown = only - CONFIG.keys()
    if unknown:
        print(f"error: unknown model(s) in --only: {', '.join(sorted(unknown))}",
              file=sys.stderr)
        print(f"known: {', '.join(CONFIG)}", file=sys.stderr)
        return 2
    models = [m for m in CONFIG if not only or m in only]
    if not models:
        print("error: nothing to build", file=sys.stderr)
        return 2

    # Preflight: every selected model MUST have a source SVG. Missing sources
    # are a fatal config/repo error, not something to silently skip.
    missing = [m for m in models if not (src_dir / f"{m}.svg").exists()]
    if missing:
        print(f"error: missing source SVG(s): "
              f"{', '.join(f'src/{m}.svg' for m in missing)}", file=sys.stderr)
        return 2

    if not args.no_write:
        args.out.mkdir(parents=True, exist_ok=True)

    icons: dict[str, Image.Image] = {}
    for model in models:
        icon = build_icon(model, src_dir, args.size)
        icons[model] = icon
        if not args.no_write:
            dest = args.out / f"{args.prefix}{model}.png"
            icon.save(dest, "PNG")
            print(f"  ok {model} -> {dest.name} ({args.size}px, {CONFIG[model]['bg']})")

    if args.preview:
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        build_preview(icons, args.preview)
        print(f"  preview -> {args.preview}")

    if args.preview_light:
        args.preview_light.parent.mkdir(parents=True, exist_ok=True)
        build_preview(icons, args.preview_light, bg=(235, 235, 235))
        print(f"  preview (light) -> {args.preview_light}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

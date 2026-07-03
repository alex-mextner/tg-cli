#!/usr/bin/env python3
"""agents-hooks/v1 pre-send-photo hook -> `review visual`.

REFERENCE executable for the `review-visual` descriptor. In production this file
is owned by review-cli and installed under ~/.agents/skills/review/hooks/ by
`review install-hook tg`; it is vendored here so the tg-cli hook framework has a
runnable, testable counterpart for the contract.

Contract (agents-hooks/v1):
  - stdin: a JSON event
      {tool:"tg", point:"pre-send-photo", args:{image_path, caption, chat_id}, ...}
  - stdout: protocol JSON only  -> {"hook_api":"agents-hooks/v1","decision":...,"message":...}
  - stderr: human logs
  - exit code is the CANONICAL block signal:
      exit 0  -> allow (decision:"allow")
      exit 10 -> BLOCK (decision:"block", message = the verdict reason)
      any other exit -> hook error (the host applies its on_error policy)

Verdict mapping (architecture spec §7.3):
  - review verdict keep                 -> allow, exit 0
  - review verdict rollback (unstyled / broken / blank)
                                        -> block, exit 10, message from reason
  - human_review / unverified / no API  -> allow + WARN (fail-open), exit 0
    (a missing API key or an indecisive vision call must never brick a send)
"""

# PEP 563: defer annotation evaluation so `str | None` / `tuple[...]` parse on
# Python 3.7+ (generic `/usr/bin/env python3` may be 3.9). Without this, the
# module fails to import on <3.10 and — with on_error=open — every photo would
# send UNGATED. Must be the first statement after the docstring.
from __future__ import annotations

import json
import shutil
import subprocess
import sys

BLOCK_EXIT_CODE = 10
HOOK_API = "agents-hooks/v1"
REVIEW_TIMEOUT_S = 55


def emit(decision: str, message: str | None = None) -> None:
    out = {"hook_api": HOOK_API, "decision": decision}
    if message:
        out["message"] = message
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


def warn(msg: str) -> None:
    sys.stderr.write(f"review-visual: {msg}\n")
    sys.stderr.flush()


def allow(message: str | None = None) -> int:
    emit("allow", message)
    return 0


def block(message: str) -> int:
    emit("block", message)
    return BLOCK_EXIT_CODE


# --- empty-editor watermark heuristic (WARN-only, see main()) --------------
#
# VS Code renders a small, muted "watermark" of keybinding-hint rows dead
# center of the editor PART only when the active editor group has ZERO open
# tabs — a genuinely empty editor/preview pane. This is a much NARROWER
# signal than the removed looks_like_vscode_window() (HYP-891): that one
# matched ANY full window via a dark, uniform left activity-bar strip and
# false-positived on legitimate content-full screenshots at least twice in
# one day. A watermark only ever renders over a perfectly flat editor
# background with a tiny, compact cluster of hint-row glyphs — a real code
# file, canvas render, or webview fills the same region with dense, varied
# content and cannot produce this pattern, regardless of whether the
# surrounding Explorer/Inspector/Logs panels are busy (they usually are, per
# Alex's tg#6041 full-window proof standard, so the check is scoped to a
# central box rather than the whole image).
#
# CALIBRATION: reasoned from VS Code's known watermark layout (a short list
# of hint rows, centered in the editor part), NOT verified against a
# captured reference screenshot of an actual empty editor group. The exact
# thresholds below are best-effort. That is exactly the gap that made the
# original heuristic's overly broad "dark left strip" match legitimate
# content — see main() for why this stays WARN-only, not a block, until
# field-calibrated.
#
# BOX PLACEMENT (review finding): the watermark centers on the EDITOR PART,
# not the WINDOW -- on a real full-window screenshot the editor part is
# offset right by the Activity Bar + Explorer sidebar (~15-20% of width) and
# only re-centered if a same-width panel is docked on the right too. A box
# symmetric around the window's horizontal center can miss the cluster
# entirely on the common "Explorer open, nothing docked right" layout. The
# box below is deliberately WIDE and asymmetric (biased right) to cover both
# a truly centered watermark and one shifted right by a typical sidebar,
# rather than a value calibrated from a real screenshot (none was available).

WATERMARK_BOX = (0.20, 0.90, 0.15, 0.65)  # (x0, x1, y0, y1) fractions of W,H
WATERMARK_SAMPLE_STEP = 3
WATERMARK_QUANT = 8  # bucket size for the background-color estimate, see _mode_color
WATERMARK_BG_TOL = 20
# Lower bound (review finding): VS Code's real hint rows are THIN text/icon
# strokes, not a filled block. A synthetic icon block + 5 thin (3px) text
# rows -- deliberately sized so every stroke is guaranteed at least one
# sampled pixel regardless of the WATERMARK_SAMPLE_STEP=3 grid's phase --
# samples at ratio ~0.006 on the box+grid size above, just above the
# original 0.005 floor. Real hint text could plausibly render even thinner
# (sub-3px strokes / anti-aliasing) than that synthetic floor case, so this
# is lowered with a safety margin below it rather than exactly at the
# measured value. Still > 0 so a perfectly solid/blank pane (zero glyphs, a
# different bug signature) stays rejected.
WATERMARK_NONBG_RATIO_RANGE = (0.001, 0.10)
# Compactness caps (review finding): (0.70, 0.80) let a cluster cover up to
# 70-80% of the box and still count as "compact" -- effectively disabling
# the check the docstring/CHANGELOG claim distinguishes a watermark from
# real content. The measured positive fixtures (a solid glyph block, a
# right-shifted block, an icon+thin-text-row cluster) all span <=0.26 on
# either axis; a two-cluster fixture spanning ~54% of the box width is
# exactly the kind of spread-out pattern real content could produce and is
# NOT "small, compact". Tightened with real margin above the measured
# positive cases, well below where that moderate-spread case lands.
WATERMARK_MAX_SPAN_RATIO = (0.35, 0.40)  # (x span, y span) vs box size


WATERMARK_BOX_MAX_DIM = 1200  # cap the CROPPED box before per-pixel sampling, see _sample_box
WATERMARK_MAX_FILE_BYTES = 20 * 1024 * 1024  # skip the heuristic outright above this, see _sample_box
WATERMARK_MAX_PIXELS = 24_000_000  # skip above this DECODED pixel count too, see _sample_box


def _downscale_box_if_needed(box):
    """Cap the per-pixel work regardless of source resolution (review
    finding: an uncapped Retina/4K screenshot's box can be ~2700x1100 -- a
    few hundred ms of pure-Python PixelAccess work on every send, with no
    timeout unlike the `review visual` call). The span/compactness ratios
    are scale-invariant; the density ratio is APPROXIMATELY so (review
    finding: BOX/area-averaging can blend a very thin, single-pixel stroke
    into the background enough to fall inside WATERMARK_BG_TOL, nudging
    non_bg_ratio down -- accepted for a WARN-only heuristic, not a proven
    equivalence). BOX resampling still beats NEAREST here: it keeps a thin
    stroke visible as a blended gray pixel rather than a coordinate gap that
    could drop it entirely on an unlucky NEAREST sample point.

    `Image.Resampling` (the enum) only exists on Pillow >= 9.1 -- on older
    Pillow this attribute access raises AttributeError, which the caller's
    blanket `except Exception` swallows into a silent False, meaning the
    heuristic would NEVER fire on exactly the large screenshots this cap
    targets (review finding). `getattr(Image, "Resampling", Image).BOX`
    falls back to the pre-9.1 flat `Image.BOX` constant."""
    from PIL import Image

    resampling = getattr(Image, "Resampling", Image)
    bw, bh = box.size
    longest = max(bw, bh)
    if longest <= WATERMARK_BOX_MAX_DIM:
        return box
    scale = WATERMARK_BOX_MAX_DIM / longest
    return box.resize((max(1, round(bw * scale)), max(1, round(bh * scale))), resampling.BOX)


def _sample_box(image_path: str) -> tuple:
    """Load image_path and return (box_w, box_h, samples) for the central
    watermark box, where samples is a list of (x, y, (r,g,b)) within the box,
    coordinates relative to the box's own origin."""
    import os

    # WATERMARK_BOX_MAX_DIM (see _downscale_box_if_needed) only bounds the
    # SAMPLING loop -- it can't bound `Image.open(...).convert("RGB")`
    # itself, which forces a full decode of the SOURCE resolution first
    # (review finding: unlike the `review visual` subprocess call, this has
    # no timeout, and a large photo -- e.g. a 24MP phone photo sent through
    # the same pre-send-photo point -- would add real, unbounded decode
    # latency to every send). A cheap `os.path.getsize` stat (no decode, and
    # deliberately BEFORE `from PIL import Image` -- review finding: an
    # earlier version imported PIL first, so this short-circuit wasn't
    # actually PIL-free and broke in a no-Pillow environment) skips the
    # heuristic outright for anything pathologically large; ordinary
    # screenshots (a few MB at most) are unaffected.
    try:
        if os.path.getsize(image_path) > WATERMARK_MAX_FILE_BYTES:
            return 0, 0, []
    except OSError:
        return 0, 0, []

    from PIL import Image

    im = Image.open(image_path)  # header-only: does NOT decode pixel data yet
    w, h = im.size

    # WATERMARK_MAX_FILE_BYTES bounds the COMPRESSED size on disk, not the
    # decoded pixel count (review finding): a highly-compressed JPEG can be a
    # few MB but decode to tens of megapixels, and `.convert("RGB")` below
    # forces that full decode with no timeout -- there is no subprocess
    # boundary here to enforce one, unlike `review visual`. `im.size` is
    # metadata read from the file header -- cheap, no pixel decode -- so
    # this check runs BEFORE paying that cost, not just before the
    # file-size guard's cost. 24MP (~6000x4000, a common phone/DSLR
    # resolution) caps worst-case decode+convert time in the low hundreds
    # of ms rather than leaving it fully open-ended; still fail-open (skip
    # the heuristic, never blocks the send) above the cap.
    if w * h > WATERMARK_MAX_PIXELS:
        return 0, 0, []
    if w < 800 or h < 500:
        return 0, 0, []

    im = im.convert("RGB")

    fx0, fx1, fy0, fy1 = WATERMARK_BOX
    box = im.crop((int(w * fx0), int(h * fy0), int(w * fx1), int(h * fy1)))
    box = _downscale_box_if_needed(box)

    bw, bh = box.size
    bpx = box.load()

    samples = []
    for y in range(0, bh, WATERMARK_SAMPLE_STEP):
        for x in range(0, bw, WATERMARK_SAMPLE_STEP):
            samples.append((x, y, bpx[x, y]))
    return bw, bh, samples


def _trimmed_span_ratio(coords: list, size: int, trim: float = 0.05) -> float:
    """Compactness span, robust to a lone outlier. A raw (max - min) span is
    blown up to ~1.0 by a single stray non-bg pixel far from the hint-row
    cluster (a minimap sliver, a scrollbar edge, an AA fringe) that can land
    inside the sample box on a real full-window screenshot — which would make
    the detector MISS the very watermark it exists to catch (review finding).
    Trimming the outer `trim` fraction of coordinates at each end absorbs a
    few stray pixels while still rejecting genuinely spread-out content.

    `int(n * trim)` alone rounds to 0 for any n below ~1/trim -- with
    trim=0.05 that's every n <= 19, exactly the sparse-cluster sample counts
    the lowered density floor (WATERMARK_NONBG_RATIO_RANGE) now allows
    through (review finding: a real sparse watermark can land in that exact
    range). At those counts the trim was silently a no-op. Guarantee at
    least ONE point trimmed off each end once there are enough points for
    that to leave a non-empty core; below that, trimming would erase the
    signal entirely, so skip it. "Non-empty" specifically means a core of
    >= 2 points (n - 2*k >= 2), not merely >= 1 (review finding): a 1-point
    core collapses to span=0 regardless of the real spread -- e.g. 3 points
    at [0, 500, 1000] would trim to the single midpoint and read as
    perfectly compact. That's unreachable through the full detector
    pipeline today (the density floor guarantees far more samples than
    that), but this function is documented as a general-purpose, unit-
    tested-in-isolation utility, so its own contract must hold regardless.

    KNOWN LIMIT (review finding): trimming is per-axis and caps at ~`trim`
    fraction of the mass on each end, so it defends against a LONE outlier
    (a handful of stray pixels), not a genuine second cluster that happens
    to hold less than that fraction of the total -- an asymmetric bimodal
    split (e.g. 95% of the mass in one cluster, 5% in a second, far-away
    one) could still trim the minority cluster away and read as "compact".
    Same root cause at small n (review finding): for 4 <= n <= 19,
    `max(1, int(n*trim))` forces k=1 regardless of n, so exactly ONE stray
    point is absorbed per end -- TWO outliers on the SAME side at that n
    range aren't both trimmed, and the span can still blow up. Accepted for
    a WARN-only, unvalidated heuristic; a real fix needs actual clustering
    (e.g. connected components), not a 1D span statistic."""
    if not coords or size == 0:
        return 1.0
    ordered = sorted(coords)
    n = len(ordered)
    max_k = (n - 2) // 2  # largest k that still leaves a >=2-point core
    k = min(max(1, int(n * trim)), max_k) if max_k >= 1 else 0
    lo = ordered[k]
    hi = ordered[n - 1 - k]
    return (hi - lo) / size


def _mode_color(samples: list) -> tuple:
    """Estimate the dominant background color by counting QUANTIZED buckets,
    not exact RGB tuples: a real screenshot (PNG re-encoding, Telegram's JPEG
    re-compression, sub-pixel font AA bleeding into nearby pixels) rarely
    repeats one EXACT color across a majority of samples even over a
    genuinely flat editor background — the true signal is a tight CLUSTER of
    near-identical colors, not one literal recurring tuple."""
    counts: dict = {}
    q = WATERMARK_QUANT
    for _, _, c in samples:
        bucket = (c[0] // q, c[1] // q, c[2] // q)
        counts[bucket] = counts.get(bucket, 0) + 1
    bucket = max(counts, key=counts.get)
    return tuple(v * q + q // 2 for v in bucket)


def looks_like_empty_vscode_watermark(image_path: str) -> bool:
    """True if the central editor-pane box looks like VS Code's empty-editor-
    group watermark: overwhelmingly flat background, plus a small, compact,
    non-zero cluster of non-background pixels (the hint-row glyphs) — not
    dense content, and not a perfectly solid/blank region either (a
    blank/crashed webview is a DIFFERENT bug signature with zero glyphs, left
    to `review visual` to catch). Best-effort: any error / no PIL -> False
    (fail-open, never brick a send on this heuristic alone)."""
    try:
        bw, bh, samples = _sample_box(image_path)
        if not samples:
            return False

        bg = _mode_color(samples)
        tol = WATERMARK_BG_TOL
        non_bg = [
            (x, y)
            for x, y, c in samples
            if abs(c[0] - bg[0]) > tol or abs(c[1] - bg[1]) > tol or abs(c[2] - bg[2]) > tol
        ]
        total = len(samples)
        non_bg_ratio = len(non_bg) / total
        lo, hi = WATERMARK_NONBG_RATIO_RANGE
        if not (lo <= non_bg_ratio <= hi):
            return False

        xs = [p[0] for p in non_bg]
        ys = [p[1] for p in non_bg]
        span_x_ratio = _trimmed_span_ratio(xs, bw)
        span_y_ratio = _trimmed_span_ratio(ys, bh)
        max_span_x, max_span_y = WATERMARK_MAX_SPAN_RATIO
        return span_x_ratio <= max_span_x and span_y_ratio <= max_span_y
    except Exception:  # noqa: BLE001 - any failure must fail OPEN, never brick a send
        return False


def warn_empty_watermark_if_detected(image_path: str) -> None:
    """WARN-only, NOT a block: unlike the removed looks_like_vscode_window()
    heuristic (HYP-891, which matched ANY full window via a dark left
    activity-bar strip and false-positived on legitimate content-full
    screenshots at least twice in one day), this one targets a narrow,
    specific signal — VS Code's own "no tabs open" watermark in the editor
    pane — that IS a real defect for a proof screenshot: an empty
    editor/preview pane proves nothing. But its thresholds are reasoned from
    VS Code's layout, not calibrated against a captured reference screenshot,
    and the exact HYP-891 failure mode (an unvalidated pixel heuristic
    hard-blocking a legitimate send) is one bad threshold away from
    recurring. Surfacing it as a warning — visible in the audit trail without
    bricking the send — is the deliberate choice until it's field-validated;
    promoting it to a block is a follow-up once real false-positive/negative
    data exists."""
    if looks_like_empty_vscode_watermark(image_path):
        # This hook runs on every pre-send-photo event, not just IDE
        # screenshots (review finding) -- the message names the VS Code
        # signature this pattern was DESIGNED to catch, but stays hedged
        # ("possible" / "consistent with") since the same small-compact-
        # element-on-flat-background shape is also produced by, say, a
        # centered dialog or a lone logo on a plain background.
        warn(
            "possible empty-editor watermark: a small compact element on an otherwise "
            "flat central pane, consistent with VS Code's 'no tabs open' hint rows — this "
            "screenshot may not actually show what the caption claims; not blocking "
            "(unvalidated heuristic, see HYP-891 follow-up)"
        )


def run_review_visual(image_path: str) -> subprocess.CompletedProcess | None:
    """Invoke `review visual --json --strict` on image_path. Returns None on
    any fail-open condition (no `review` on PATH, timeout, OSError) — the
    caller must treat None as an immediate allow()."""
    review_bin = shutil.which("review")
    if not review_bin:
        warn("`review` not on PATH — allowing (fail-open)")
        return None

    cmd = [review_bin, "visual", image_path, "--json", "--strict"]
    try:
        return subprocess.run(  # noqa: S603 - args are fixed, image_path from the host event
            cmd,
            capture_output=True,
            text=True,
            timeout=REVIEW_TIMEOUT_S,  # < descriptor timeout_ms (60s) so we own the timeout
        )
    except subprocess.TimeoutExpired:
        warn("`review visual` timed out — allowing (fail-open)")
        return None
    except OSError as exc:
        warn(f"could not run `review visual`: {exc} — allowing (fail-open)")
        return None


def decide_from_review_result(proc: subprocess.CompletedProcess) -> int:
    """Map a completed `review visual` run to the hook's allow/block decision
    (architecture spec §7.3 verdict mapping)."""
    verdict, malformed = parse_review_output(proc.stdout)
    decision = verdict.get("decision") or verdict.get("verdict")
    reason = verdict.get("reason") or verdict.get("message") or ""

    # `review visual --strict` itself exits 10 on a rollback verdict; honour
    # that directly (it is the same canonical block signal).
    if proc.returncode == BLOCK_EXIT_CODE or decision == "rollback":
        return block(reason or "review visual: unstyled / broken render")

    # A zero exit with NON-EMPTY but UNPARSEABLE stdout is a broken/noisy review
    # binary, NOT a clean keep — warn and fail open (don't masquerade as keep).
    if proc.returncode == 0 and malformed:
        warn("review visual emitted malformed stdout (not JSON) — allowing (fail-open)")
        return allow()

    # A clean "keep" verdict is the only unconditional allow. A zero exit with NO
    # decision field AND empty/clean stdout is also a clean allow.
    if decision == "keep" or (proc.returncode == 0 and decision is None and not malformed):
        return allow()

    # Everything else — human_review / unverified / unknown decision, or a
    # non-zero-but-not-10 exit — is INDECISIVE. Fail open, but WARN + audit so an
    # unverified visual check is never silently indistinguishable from a clean
    # keep (architecture spec §7.3: human_review/unverified default allow + warn).
    warn(
        f"review visual indecisive (decision={decision!r}, rc={proc.returncode}) "
        f"— allowing (fail-open)"
    )
    return allow(reason or None)


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        # We could not read the event — fail open (do not brick the send).
        warn(f"could not parse stdin event: {exc}")
        return allow()

    args = event.get("args") or {}
    image_path = args.get("image_path")
    if not image_path:
        warn("no image_path in event args — allowing")
        return allow()

    # NOTE: this hook previously ran a `looks_like_vscode_window()` pixel heuristic
    # that BLOCKED every full VS Code window screenshot (dark left activity-bar
    # strip = block), forcing callers to crop to the preview pane/iframe. Removed
    # 2026-07-03 (HYP-891) at Alex's explicit direction: his tg#6041 standard made
    # full-window screenshots (Explorer/Inspector/Logs panels visible) the DEFAULT
    # desired HyperIDE diagnostic proof format, and the heuristic — which only
    # detected "is this a full window", not "is the preview inside it broken" —
    # hard-blocked that default, legitimate case at least twice in one day.
    #
    # KNOWN TRADEOFF (accepted, not solved): the `review visual --strict` call
    # below is the only remaining gate on a full-window shot, and it judges the
    # WHOLE image — the same limitation the original heuristic's author cited as
    # the reason a broken/unstyled preview pane could get visually diluted behind
    # busy editor chrome. That risk is real and UNVERIFIED either way (no
    # regression test proves `review visual` does or doesn't catch it on a full
    # window). Alex explicitly weighed this and chose to accept it rather than
    # keep gating the now-default proof format — see tg#6063/6064.
    #
    # INTENTIONAL: the watermark scan runs BEFORE the `review` PATH check
    # below, unlike the old fast-path order (review finding: `review`-absent
    # hosts now decode+sample every image, ~tens of ms, where they previously
    # did zero image work). Kept unconditional on purpose — the watermark
    # WARN is independently useful audit-trail signal ("this screenshot may
    # not show what the caption claims") regardless of whether the `review
    # visual` block-gate is even installed on this host, not something that
    # should silently go dark just because the OTHER check is unavailable.
    warn_empty_watermark_if_detected(image_path)

    proc = run_review_visual(image_path)
    if proc is None:
        return allow()
    return decide_from_review_result(proc)


def parse_review_output(stdout: str) -> tuple[dict, bool]:
    """Return (verdict, malformed). malformed is True when stdout is NON-EMPTY
    but not a JSON object — distinct from empty stdout (a clean, structured-less
    success)."""
    stdout = stdout.strip()
    if not stdout:
        return {}, False
    try:
        parsed = json.loads(stdout)
        if isinstance(parsed, dict):
            return parsed, False
        return {}, True
    except (json.JSONDecodeError, ValueError):
        return {}, True


if __name__ == "__main__":
    sys.exit(main())

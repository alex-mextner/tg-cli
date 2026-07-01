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


def looks_like_vscode_window(image_path: str) -> bool:
    """Heuristic: a FULL VS Code WINDOW screenshot has a dark, UNIFORM vertical
    activity bar on the far-left edge and is window-wide. Preview proofs must be
    CROPPED to the iframe/pane — a full-window shot dilutes a broken/unstyled/
    overlapping preview behind the styled editor chrome, so both the human eye and
    `review visual` (which judges the whole image) miss it. We BLOCK these to force
    a crop. Calibrated: full window left-strip ~[25,26,27]; cropped pane ~[243,237,231].
    Best-effort: any error / no PIL -> treat as NOT a window (fail-open)."""
    try:
        from PIL import Image

        im = Image.open(image_path).convert("RGB")
        w, h = im.size
        if w < 1000:  # a cropped preview pane is narrow; a real editor window is wide
            return False
        xs, ys = (4, 8, 12), tuple(int(h * f) for f in (0.15, 0.3, 0.5, 0.7, 0.85))
        px = [im.getpixel((x, y)) for x in xs for y in ys]
        means = [sum(p[i] for p in px) / len(px) for i in range(3)]
        spread = max(max(p[i] for p in px) - min(p[i] for p in px) for i in range(3))
        # dark (each channel < 60) AND flat (uniform strip = a chrome bar, not content)
        return all(m < 60 for m in means) and spread < 40
    except Exception:  # noqa: BLE001 - any failure must fail OPEN, never brick a send
        return False


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

    # Enforce CROPPED preview proofs: a full VS Code window screenshot is blocked so a
    # broken/unstyled/overlapping preview pane can't hide behind the styled editor chrome
    # (the review visual gate below judges the WHOLE image and would pass it). This is the
    # durable mechanism behind "always send cropped proofs" — a hook, not a verbal promise.
    if looks_like_vscode_window(image_path):
        return block(
            "Full VS Code WINDOW screenshot detected (dark left activity bar). Crop the proof "
            "to the PREVIEW PANE / iframe and resend — a full-window shot hides a broken or "
            "unstyled preview behind the styled editor chrome (the visual gate and the eye both "
            "miss it). Re-capture cropped, e.g. `iframeElement.screenshot({path})`."
        )

    review_bin = shutil.which("review")
    if not review_bin:
        warn("`review` not on PATH — allowing (fail-open)")
        return allow()

    cmd = [review_bin, "visual", image_path, "--json", "--strict"]

    try:
        proc = subprocess.run(  # noqa: S603 - args are fixed, image_path from the host event
            cmd,
            capture_output=True,
            text=True,
            timeout=REVIEW_TIMEOUT_S,  # < descriptor timeout_ms (60s) so we own the timeout
        )
    except subprocess.TimeoutExpired:
        warn("`review visual` timed out — allowing (fail-open)")
        return allow()
    except OSError as exc:
        warn(f"could not run `review visual`: {exc} — allowing (fail-open)")
        return allow()

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

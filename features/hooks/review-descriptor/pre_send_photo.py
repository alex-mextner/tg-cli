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

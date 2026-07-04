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


# Telegram captions cap out around 1024 characters, but this hook is a defensive
# gate that runs BEFORE the send — it must not lean on an upstream limit it can't
# see. A generous ceiling well past that real-world cap, chosen to stay far under
# Linux's ~128KB single-arg / macOS's ~256KB total-argv exec limits (an oversized
# --intent would otherwise raise OSError "Argument list too long" at subprocess.run
# call time, caught by the widened except below, and disable verification for that
# photo entirely — review found).
_MAX_INTENT_CHARS = 4096


def _safe_intent(caption: object) -> str:
    """Sanitize an outgoing photo caption into a value safe to append as a single
    subprocess argv element, or "" if it can't be made safe (in which case `review
    visual` still runs, just without --intent — see the call site for why dropping
    it beats letting a malformed caption crash the whole verification call)."""
    if not isinstance(caption, str):
        return ""
    text = caption.replace("\x00", "").strip()[:_MAX_INTENT_CHARS]
    if not text:
        return ""
    try:
        text.encode(sys.getfilesystemencoding(), "strict")
    except (UnicodeEncodeError, LookupError):
        return ""
    return text


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
    # Forward the outgoing caption as --intent: it is the ONLY signal `review visual`
    # has of what the sender claims the screenshot shows (e.g. "element selected").
    # Without it, an intent-gated check like selection-highlight's hard CV veto never
    # activates for ANY tg-sent photo, in ANY language (tg#6188) — the caption was
    # already in the event args and simply ignored. --intent is documented as
    # UNTRUSTED, read-only free text on review's side: it can only TIGHTEN which
    # checks run / how strict the contract is, never loosen a verdict — this hook's
    # whole safety case rests on that being true, since it now hands the sender's own
    # text a channel into the gate. Verified directly against review-cli's source (not
    # just its docstring) as of alex-mextner/review-cli#110:
    #   - reviewlib/features/visual/contract.py::derive_contract / _intent_raises_risk
    #     only ever RAISES risk from intent, never lowers it (`if risk != "high"` guard).
    #   - reviewlib/features/visual/registry.py::ContributedModule.activates and
    #     reviewlib/features/visual/contrib/selection_highlight.py's own `activates`
    #     only ever ADD activation from intent (an OR of independent conditions) — there
    #     is no path where intent text can turn OFF a check.
    # No code path lets intent DEACTIVATE a check or LOWER risk, so forwarding arbitrary
    # caption text here is safe by that existing, source-verified contract.
    #
    # NOT runtime-enforced: `review_bin` below resolves via PATH to WHATEVER review-cli
    # is installed, not pinned to the commit this was verified against — there is no
    # version check here. If a future review-cli release ever let intent loosen a
    # verdict, this hook would silently inherit that (the sender-controlled caption
    # would gain real leverage over the gate). Deliberately not adding version
    # enforcement for that here — out of proportion to this fix — but flagging it as an
    # assumption this hook depends on, not a runtime-checked guarantee.
    #
    # ACCEPTED TRADE-OFF: this now applies to EVERY tg photo, not just ones an actor
    # deliberately marked for verification. An ordinary caption that happens to mention
    # a visual concept unrelated to this specific render (e.g. "selected the file in the
    # sidebar") can now trigger an intent-gated CV veto that stayed silent before. That
    # is accepted for the same reason review-cli's own synonym trade-off is (tg#6188):
    # a spurious block is loud and recoverable (resend without that wording, or with
    # --check), a silently-passed false "selected" screenshot is not.
    #
    # Trimmed (not byte-for-byte "verbatim"): only leading/trailing whitespace is
    # stripped; NUL bytes are dropped too, since embedding one in a subprocess argv
    # raises ValueError at call time.
    #
    # CRITICAL: an unencodable caption must DROP --intent, not crash the subprocess
    # call. A NUL byte is not the only argv-breaking input — an unpaired UTF-16
    # surrogate (e.g. a lone "\ud800", which survives a JS JSON.stringify ->
    # Python json.loads round-trip intact) raises UnicodeEncodeError when
    # subprocess.run encodes argv, and that is ALSO a ValueError subclass. If that
    # were allowed to propagate into the `except (OSError, ValueError)` below, a
    # sender crafts one caption and the ENTIRE `review visual` call — not just
    # --intent — never runs, resolving to allow(): a caption would then be able to
    # disable visual verification outright, exactly the "intent can loosen a
    # verdict" case the safety comment above says can't happen (review found this
    # as a real, security-relevant gap in an earlier draft of this fix — a bare NUL
    # strip did not cover it). So: pre-flight-encode `intent` here, and on ANY
    # failure drop it to "" (verification still runs, just without --intent) rather
    # than let a malformed value reach subprocess.run at all.
    caption = args.get("caption")
    intent = _safe_intent(caption)

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
    if intent:
        # `--intent=<value>` as ONE token, not two ([`--intent`, intent]): a caption
        # starting with `-`/`--` (e.g. "-> selected", "--fix applied") would otherwise
        # be parsed by argparse as the NEXT option rather than --intent's value,
        # breaking the whole `review visual` call for that caption (review found).
        cmd.append(f"--intent={intent}")

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
    except (OSError, ValueError) as exc:
        # ValueError alongside OSError: subprocess.run raises it (not OSError) for a
        # malformed argv — e.g. an embedded NUL byte, or an unencodable character
        # (a lone UTF-16 surrogate) that can't be encoded for the OS's argv/exec
        # call. `intent` can no longer trigger either (pre-validated by
        # `_safe_intent` above — a NUL or an unencodable caption drops `--intent`
        # entirely rather than reaching subprocess.run), so this is NOT protecting
        # the --intent path; it guards `image_path`, which comes from the event
        # args unfiltered (a pre-existing, still-open channel).
        #
        # Verified WHERE a NUL in image_path actually surfaces (checked, not assumed —
        # review flagged this as exactly the kind of claim that needs proof, not a
        # docstring): `looks_like_vscode_window()` above calls `Image.open(image_path)`,
        # which raises this SAME ValueError first — but that function's own `except
        # Exception` already swallows it and returns False, so execution reaches this
        # `cmd`/subprocess.run unchanged. subprocess.run then raises its OWN ValueError
        # for the same NUL, still present in argv, and THAT is what this except
        # catches. Manually confirmed by running the corresponding test
        # ('NUL byte in imagePath...' in hooks-review-descriptor.test.ts) and reading
        # its console stderr output: the warning text is this branch's own
        # "could not run `review visual`: embedded null byte", not a message from
        # anywhere else — i.e. NOT a silent pass-through of the vscode-window check,
        # NOT a bare uncaught crash resolved by the JS harness. That specific text is
        # not itself asserted in the test (HookRunResult exposes no stderr-capture
        # field to assert against), so re-verify by eye if this code path changes.
        #
        # Also confirmed this is not a fail-CLOSED -> fail-open regression for THIS
        # descriptor: review-visual.pre-send-photo.json sets on_error:"open", and
        # run-photo-hooks.ts's resolveDecision() already treats ANY abnormal exit
        # (crash/timeout/non-canonical code) as a hook ERROR resolved by that policy —
        # an uncaught exception here was ALREADY fail-open end-to-end before this
        # change, just resolved one layer up (in the JS harness) instead of here.
        # Catching it here only changes WHERE the same allow() decision is made, not
        # what it resolves to, under the on_error the shipped descriptor actually uses.
        warn(f"could not run `review visual`: {exc} — allowing (fail-open)")
        return allow()

    # KEEP stdout parsing OUTSIDE the try above: json.JSONDecodeError is itself a
    # ValueError subclass. If a future edit folds `parse_review_output(proc.stdout)`
    # into that try, a malformed/empty JSON response from `review` would silently
    # resolve to allow() here instead of hitting the dedicated "malformed stdout"
    # handling below (review found this as a latent trap in the widened except).
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

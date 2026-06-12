# q→buttons — does it work, and what are the prerequisites? (item 4)

Verification done 2026-06-12 on this machine.

## Short answer

The **daemon half works and is tested**; the feature does **NOT** function
end-to-end out of the box because the **agent-side hook is not installed and the
repo ships no installer for it**. Agent questions never reach Telegram until that
hook exists.

## What is shipped and proven

- `tg-ctl ask` (the hook client): reads a normalized question/permission JSON on
  stdin, talks to the running daemon over the bot-scoped Unix socket
  (`~/.config/tg-cli/tg-ctl.<botid>.sock`), waits for the answer. (`tg-ctl` main,
  `askDaemon`.)
- Daemon side: `startHookServer` (0600 socket, 64 KiB cap), inline-button message
  build, `callback_query` routing in the same poll stream, immediate
  `answerCallbackQuery`, expiry editing, and per-agent hook-output formatting
  (`features/tg-ctl/questions.ts`). Covered by `tests/ctl-buttons-integration.test.ts`
  and `tests/ctl-buttons-failure-integration.test.ts` (green, part of the suite).
- A `tg-ctl run` daemon was **live on this machine** during verification
  (PID confirmed), so the socket path is real.

## The blocker: no hook installed, no installer

- `~/.claude/settings.json` `PreToolUse` entries are `Bash`→rtk and
  `EnterWorktree`→deps — **no `AskUserQuestion` / `PermissionRequest` → `tg-ctl
  ask` hook**.
- The only installer in the repo is `features/install-skill` (a SessionStart hook
  for *skill awareness*) — unrelated. The q→buttons hook installer was explicitly
  **deferred** in the spec (`docs/specs/2026-06-10-tg-ctl-control-design.md` §8,
  §16 "Deferred: idempotent hook installer, Claude canary test").

So today the user must hand-add the hook to `~/.claude/settings.json`.

## Full prerequisite checklist

1. **`~/.config/tg-cli/.env`** with `TG_BOT_TOKEN` + `TG_CHAT_ID` (present here).
2. **One `tg-ctl` daemon running** for the bot (auto-starts from `tg` when inside
   tmux **and** `control.enabled` — default ON; or `tg-ctl start`). Singleton via
   flock; one machine per bot token (else Telegram 409).
3. **The asking session is the registered control target.** The daemon checks
   each hook request with `registrationAllowsHook`: `paneId` is authoritative;
   else `cwd`; else `sessionName`. A mismatch fast-passes with NO Telegram prompt
   (so a globally installed hook never blocks an unrelated keyboard session). The
   registration is written by the last `tg` send (last-write-wins) — i.e. the
   pane that most recently called `tg`.
4. **The agent-side hook is installed** (the missing piece):
   - **Claude Code**: `PreToolUse` matcher `AskUserQuestion` → `tg-ctl ask` →
     return `{hookSpecificOutput:{permissionDecision:"allow",updatedInput:{questions,answers:{<question text>:<label>}}}}`;
     and `PermissionRequest` → `{hookSpecificOutput:{decision:{behavior:"allow"|"deny"}}}`.
     Note the AskUserQuestion contract is an **undocumented internal** (answers
     keyed by question TEXT, multiSelect = comma-joined, `updatedInput` replaces
     wholesale so it must include `questions`).
   - **Codex**: `PermissionRequest` only; hooks must be trusted by hash via
     `/hooks` on first run (manual).
   - **opencode**: native SSE question/permission events — no tmux hook needed.
5. **A per-hook timeout** (~120 s) in settings; on expiry the local dialog takes
   over and the daemon edits the TG message to "expired".

## Agent capability matrix

| Agent | Questions | Permissions | Notes |
|---|---|---|---|
| Claude Code | ✅ buttons | ✅ buttons | needs the undocumented AskUserQuestion hook |
| Codex | ❌ | ✅ buttons | manual `/hooks` trust |
| opencode | ✅ | ✅ | native, no tmux |
| pi / aider / gemini | ❌ | ❌ | tmux floor only; bot replies "limited" |

## Recommendation

Build the deferred **idempotent hook installer** (`tg-ctl install-hooks` or fold
into `tg install-skill`) plus the **Claude canary e2e** that fails loudly on
contract drift. Until then, q→buttons is "daemon-ready, hook-missing" — wire the
hook manually to use it. (Offered as a follow-up, not built here — it edits the
user's global `~/.claude/settings.json` and the spec wants the canary alongside.)

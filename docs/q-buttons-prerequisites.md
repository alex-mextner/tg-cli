# q→buttons — does it work, and what are the prerequisites? (item 4)

Verification done 2026-06-12 on this machine.

## Short answer

The **daemon half works and is tested**. As of v1.6.0 the missing pieces are now
shipped (this branch): a one-command **installer** (`tg-ctl install-hooks`)
idempotently wires the Claude Code hook, `tg-ctl ask` **normalizes the raw
harness payload** (so the installed hook is trivial), and `tg-ctl status` reports
whether the hook is installed. Run `tg-ctl install-hooks` once + restart the
agent session, and agent questions reach Telegram as buttons.

> Original verification (2026-06-12) found the feature dead out of the box: the
> hook was not installed and no installer existed. That gap is closed below.

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

## Seamless setup (v1.6.0)

- **`tg-ctl install-hooks`** — idempotently merges into `~/.claude/settings.json`
  (backing it up first): a `PreToolUse` matcher `AskUserQuestion` and a
  `PermissionRequest` group, both running `tg-ctl ask`. Existing hooks are
  preserved; re-running is a no-op. Pure merge in
  `features/tg-ctl/hook-install.ts`. Codex/opencode get printed guidance (Codex
  needs a manual `/hooks` trust; opencode is native SSE).
- **`tg-ctl ask` normalizes the raw harness payload** — the hook pipes Claude
  Code's native `PreToolUse(AskUserQuestion)` / `PermissionRequest` JSON straight
  in; `features/tg-ctl/hook-normalize.ts` maps it to a `ButtonRequest` using the
  hook process's own `TMUX_PANE`/cwd/session. Single non-multiSelect questions
  with concrete options forward; multi-question / multiSelect / free-form fall
  back to the local dialog. (Codex uses `tg-ctl ask --agent codex`.)
- **`tg-ctl status`** prints `q→buttons hooks: installed / NOT installed — run
  tg-ctl install-hooks` so the state is never silently wrong.

The verified-live AskUserQuestion contract (CC 2.1.170) — `answers` keyed by
question TEXT, `updatedInput` replaces wholesale — is unchanged in
`formatAgentHookOutput`. The hook matcher is the `AskUserQuestion` tool under
`PreToolUse` (confirmed against the live hooks docs: there is no separate
`AskUserQuestion` hook event).

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

## Plan-approval (ExitPlanMode) forwarded as Proceed / Keep planning

Claude Code's plan-mode **plan-approval** is a BLOCKING prompt gated as the
`ExitPlanMode` tool. It is delivered to `tg-ctl ask` by the **`PermissionRequest *`
catch-all** the installer already wires — it does **NOT** get its own dedicated
`PreToolUse` matcher, because per the live hooks docs BOTH `PreToolUse` and
`PermissionRequest` can fire for the same ExitPlanMode call, so a second matcher
would forward the plan to Telegram twice (and leave the losing `tg-ctl ask`
blocked until its 120s timeout). `tg-ctl ask` recognizes `tool_name ===
"ExitPlanMode"` and forwards it as a permission with relabeled buttons —
**Proceed** (allow) / **Keep planning** (deny) — carrying the plan text in the
message body (clamped to stay inside Telegram's 4096-char limit; the full plan is
in the pane). A generic Approve/Reject would lose the plan and mis-word the choice.

The hook **reply shape follows the event that fired**: `normalizeHookPayload`
stamps `permissionEvent` from the payload's `hook_event_name`, and
`formatAgentHookOutput` emits `hookSpecificOutput.decision.behavior` (+ top-level
`systemMessage` on deny — the `decision` object has NO reason field, so the
keep-planning intent rides the documented universal `systemMessage`) for the
production `PermissionRequest` delivery, vs
`hookSpecificOutput.permissionDecision` (+ `permissionDecisionReason` on deny, the
keep-planning intent) if a `PreToolUse` matcher ever delivers it (another harness,
or a hand-added matcher). The two events take different output schemas — confirmed
against the live hooks docs; `behavior: "allow"` / `permissionDecision: "allow"`
alone is sufficient for ExitPlanMode, no `updatedInput` echo. The same infra (registration guard,
defer-while-waiting, routed tap reply) applies unchanged; this is the "Forward
harness confirmation / permission prompts to TG as inline buttons" item, extending
tg-cli#30.

## Defer inbound while the agent is waiting (v1.6.0)

When an agent has an outstanding button question (a `pendingButton` whose pane is
known) and a NEW inbound message would inject into that pane, the daemon does NOT
inject over the waiting prompt. It **queues** the message per-pane and reacts on
the source Telegram message with **✍️** ("noted, queued") — Telegram's allowed
reaction set has no ⏳, so ✍️ is the closest. When the question is answered, the
queue is **flushed** into the pane (after a short settle delay). Control verbs
(`/stop` = Escape) are never deferred — they go through to interrupt the prompt.

## Still open

- A **Claude canary e2e** (synthetic `AskUserQuestion` against a real `claude -p`)
  that fails loudly on contract drift — recommended next, not built here.
- Codex/opencode hook auto-write (currently guided, not auto-installed).

## Agent capability matrix (unchanged)

See the table above; the installer + normalization wire the Claude Code path
end-to-end. Codex needs the manual `/hooks` trust; opencode is native SSE.

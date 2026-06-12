# tg-cli — reply quotes forwarded into the agent (items 2, 3)

Repo: `~/.files/repos/tg-cli`. Pure logic in `features/tg-ctl/updates.ts`
(`buildReplyInject`), tests in `tests/ctl-reply-quote.test.ts`. Telegram shapes
in `features/tg-ctl/types.ts` (`reply_to_message`, `quote`).

## North star

When you **reply** (Telegram reply) to a message in the control chat — typically
an agent's own report — the agent should see *what you are answering*. The daemon
injects the reply with a one-line quote anchor:

```
↩ «[2026-06-12 14:30] migrated the DB…»
[TG from Alex] fix this — reply via tg
```

- **Item 2** — if you highlighted a **partial quote** (Telegram's quote
  selection, `message.quote.text`), that exact selection is the forwarded quote.
- **Item 3** — the anchor is `«[<date> <time>] <beginning of the message>…»`:
  the replied-to message's timestamp plus the start of its text and an ellipsis.

When both apply, the partial selection is the quoted content and it still carries
the `[date time]` + `…` framing.

## `buildReplyInject(m, name, opts)` (pure)

1. `original` = `reply_to_message.text` (or `.caption`), whitespace-collapsed.
2. `selected` = `m.quote.text` (the partial selection), whitespace-collapsed.
3. `body` = `selected || original` — item 2 wins when a selection exists.
4. `head` = first `60` chars of `body` + `…` (always ellipsised — item 3).
5. `when` = `opts.fmtTime(reply_to_message.date)`; defaults to a deterministic
   **UTC** `YYYY-MM-DD HH:MM`. The daemon injects a **local-time** formatter so
   the human sees Belgrade time while the pure module + tests stay deterministic.
6. Result: `↩ «[when] head»` + newline + the normal `wrap(name, replyText)`.

## Routing into the step function

In `stepUpdates`, a text message that **is a reply** and whose text is **not a
`/command`** becomes an `inject-text` action built by `buildReplyInject`; a reply
whose text starts with `/` still runs the command verbatim (so you can reply
`/stop` to a message). The reply inject is routed to the current target like any
inbound message and earns the 👀 receipt.

## Scope boundary (reply-to-origin-pane routing)

This delivers the **quote forwarding** (items 2, 3): the agent receives the
reply *with* the anchor identifying the original message. It routes to the
daemon's current target (last-`tg`-sender registration), which is correct in the
common single-active-agent case.

Routing a reply to the EXACT pane that produced the replied-to message — the
`message_id → {paneId, cwd}` map written by `tg` on every send (spec
`2026-06-10-tg-ctl-control-design.md` §16, deferred v1.1) — is the natural
companion for multi-agent fan-in and remains a separate follow-up. The quote
anchor already gives the receiving agent the context it needs to disambiguate.

## Non-goals

- No multi-line `> quote` block — a single compact anchor line keeps the
  injected prompt readable (the full original is one tap away in Telegram).
- No forwarding of media in the replied-to message — text/caption only.

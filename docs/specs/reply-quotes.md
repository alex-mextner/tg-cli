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
`/command`** becomes a `reply-route` action carrying the replied-to message id +
the `buildReplyInject` text; a reply whose text starts with `/` still runs the
command verbatim (so you can reply `/stop` to a message).

## Reply routing: recognized origin vs LRU/MRU picker (v1.6.0)

`tg` records every outbound message id → `{paneId, cwd, ts}` into a bounded
routes map (`features/tg-ctl/routes.ts`, `tg-ctl.<botid>.routes.json`, tmux-only,
last 300). The daemon's `handleReplyRoute`:

- **Recognized** — the replied-to id maps to a pane that STILL hosts an agent →
  inject the reply (with its anchor) straight into that origin pane. This is the
  multi-agent fan-in: replying to agent X's report reaches X, not the last
  sender.
- **Unrecognized** (id not in the map, or the pane is gone) → show the
  session-grouped **window picker** ordered by **LRU+MRU**: most-recently-messaged
  panes first, send-frequency as the tiebreaker, panes with no history last. Both
  signals are derived from the same routes map (`aggregateUsage` + `orderByLruMru`)
  — no separate usage state. A single agent skips the picker and injects directly.

The picker reuses the `/agent` selection machinery (`pendingAgent`, `tga:`
callbacks); the reply's pending message is stored `prewrapped` so the tap injects
the anchored text verbatim (no double-wrap).

Both paths honor defer-while-waiting: a reply to a pane with an open question is
queued (✍️) and flushed when the question is answered (see
`docs/q-buttons-prerequisites.md`).

## Non-goals

- No multi-line `> quote` block — a single compact anchor line keeps the
  injected prompt readable (the full original is one tap away in Telegram).
- No forwarding of media in the replied-to message — text/caption only.

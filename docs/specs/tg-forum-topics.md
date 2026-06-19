# tg-ctl — Telegram forum-topics mode (one topic = one agent)

Status: **DRAFT design** (CTO 2026-06-19 "делай"). Implemented incrementally — see
§9 Increment plan. Supersedes the flat `/agent` phonetic selector as the primary
addressing model when the bot chat is a **forum** (a supergroup with topics enabled).

## 1. Goal

Each background agent lives in its **own Telegram forum topic** (`message_thread_id`).
The topic IS the address — no phonetic disambiguation. Concretely:

- **Creating a topic spins up an agent.** A `forum_topic_created` service message starts
  a per-topic `/new` flow that asks the working **PATH** and the **MODEL**, then launches a
  fresh agent (`claude --model <model>` in `<path>`, in its own tmux window) bound to that
  topic.
- **Routing is per-topic.** An inbound message carrying `message_thread_id = T` injects into
  topic `T`'s bound pane; that agent's `tg` replies post back **into the same topic** T.
- The legacy flat-chat behaviour (`/agent`, reply-routing, `/status`, …) is unchanged for
  non-forum chats and for the forum's General topic (`message_thread_id` absent).

## 2. Why forum topics (vs the flat `/agent` picker)

The flat selector fuzzy-matches a window name out of an ambiguous pool and re-asks on every
collision. A forum topic is a **durable, unambiguous, user-visible address**: the binding is
created once (on topic creation), Telegram renders each agent as its own thread, and the user
never disambiguates. It also gives each agent an isolated transcript.

## 3. Telegram surface used

- **Forum topics** require the chat to be a **forum** (supergroup, `Topics` enabled). The bot
  must be an admin with `can_manage_topics` to create/close topics; it can always *post into*
  an existing topic with `message_thread_id`.
- **Service messages** (read-only, delivered as `message`): `forum_topic_created`
  (`{ name, icon_color?, icon_custom_emoji_id? }`), `forum_topic_edited`, `forum_topic_closed`,
  `forum_topic_reopened`. Each carries `message_thread_id` = the topic's id (== the id of the
  topic's first message).
- **Posting into a topic**: `sendMessage(..., { message_thread_id: T })`. All bot replies for a
  topic-bound agent MUST carry `message_thread_id: T` or they land in General.
- **Inbound**: a user message in topic T arrives as a normal `message` with
  `message_thread_id: T` and `is_topic_message: true`.

## 4. Lifecycle / state machine (per topic)

A topic moves through a small pure state machine (`features/tg-ctl/topics.ts`):

```
(none) --forum_topic_created--> awaiting-path
awaiting-path --user sends a path (or picks a recent-repo button)--> awaiting-model
awaiting-model --user picks a model button--> spawning --(pane up)--> bound
bound --forum_topic_closed / agent death--> closed   (re-open re-binds or re-spawns)
```

- **awaiting-path**: the bot posts (into topic T) "Which directory should this agent work in?"
  with inline buttons for recent/known repos (from the routes/registration history) + a
  free-text fallback ("or send an absolute path").
- **awaiting-model**: "Which model?" buttons — the model catalog (see §6). Default highlighted.
- **spawning**: the entrypoint runs `tmux new-window` (see §5); on success → `bound`, else an
  error is posted into the topic and the state returns to `awaiting-model` (retry).
- **bound**: `{ threadId, paneId, path, model, name }` persisted; messages route here.
- **closed**: binding retained but marked closed; a `forum_topic_reopened` or a new message
  re-attaches (re-spawn if the pane is gone).

The state machine is PURE: `(topicState, inbound|callback) -> { nextState, action? }`. The
entrypoint owns the spawn, the sendMessage, and persistence.

## 5. Spawning (the new capability)

The daemon has only ever *attached* to existing panes; topic-mode adds **spawning**. On
`spawning`:

```
tmux new-window -t <session> -n <topic-name-slug> -c <path> -P -F '#{pane_id}' \
  -- claude --model <model>
```

- `-P -F '#{pane_id}'` returns the new pane id → bound to the topic immediately (no discovery
  race). `-c <path>` sets the cwd. The agent command mirrors how a human starts the agent
  (`claude --model …`); other kinds (codex/opencode) are a follow-up via the model catalog's
  `kind`.
- The window name is a slug of the topic name (so `/agent` still works as a fallback address).
- Guardrails: `<path>` must exist and be a directory (else re-ask in `awaiting-path`); the model
  must be in the catalog; refuse to spawn a second pane for an already-`bound` topic.

## 6. Model catalog

A small declared catalog `features/tg-ctl/models.ts` (pure data) → the `awaiting-model`
buttons and the spawn command. Each entry: `{ id, label, kind: 'claude'|'codex'|'opencode',
argv: (path) => string[] }`. v1 ships the claude tiers (opus/sonnet/haiku) + a "default"
(no `--model`); codex/opencode entries land when their spawn recipe is verified. The catalog
is the single source of truth for both the buttons and the spawn argv (no drift).

## 7. Persistence

A new state file `topics` (added to `CtlPaths`): a JSON array of `TopicBinding`
`{ threadId, paneId, path, model, name, status, ts }`, written by the entrypoint on every
transition (same pattern as `routes`). On daemon restart the bindings reload; a binding whose
pane is gone is re-spawned on the next message (or marked `closed`). Capped like routes.

## 8. Routing changes (updates.ts)

`stepUpdates` gains, BEFORE the existing flat-chat dispatch:

- `message.forum_topic_created` → `{ kind: 'topic-new', threadId, name, from }` (start the flow).
- `message.message_thread_id` present AND topic is `bound` → route the (wrapped) text to that
  topic's pane via a `{ kind: 'topic-route', threadId, injectText }` action (the entrypoint maps
  `threadId → paneId`). Replies/acks for it carry `message_thread_id`.
- `message.message_thread_id` present AND topic is `awaiting-*` → feed the path/model answer to
  the state machine (`{ kind: 'topic-answer', … }`).
- `forum_topic_closed`/`reopened` → `{ kind: 'topic-close'|'topic-reopen', threadId }`.
- No `message_thread_id` (General / non-forum) → the existing behaviour, untouched.

Outbound threading: the entrypoint threads every topic-originated reply with
`message_thread_id`. The `tg` send side learns a `--topic <T>` / `TG_TOPIC` so an agent's
replies thread correctly even though `tg` runs from the pane (the binding supplies T; the agent
need not know it — the daemon stamps the route with the threadId and `tg`'s reply path reads it,
mirroring how `routes.cwd` already flows).

## 9. Increment plan (ship small, each green + reviewed)

1. **Foundation (pure core + tests)** — this PR: `types.ts` (thread/forum fields + `TopicBinding`
   + topic Actions), `features/tg-ctl/topics.ts` (binding store parse/append/lookup + the pure
   state machine), `features/tg-ctl/models.ts` (catalog), `stepUpdates` recognising the topic
   updates and emitting the new Actions, full unit tests. No spawning yet — the entrypoint logs
   the new Actions as no-ops behind a `control.topics` flag (default off) so nothing changes for
   existing users until the executor lands.
2. **Spawn + bind executor** — entrypoint handles `topic-new`/`topic-answer`: the `/new` button
   flow + `tmux new-window` spawn + persistence.
3. **Per-topic routing + outbound threading** — `topic-route` inject + `message_thread_id` on
   every topic reply/ack; `tg --topic`.
4. **Lifecycle polish** — close/reopen, re-spawn on dead pane, daemon-restart re-bind, General-vs-topic
   edge cases, admin-permission onboarding error.

## 10. Edge cases / decisions

- **Not a forum / no admin rights**: topic-mode silently inert; flat `/agent` stays the address.
  A `forum_topic_created` in a chat where the bot lacks `can_manage_topics` still binds on the
  *first user message* (the bot can post into an existing topic without managing it).
- **Path doesn't exist / not a dir** → re-ask, never spawn into a bad cwd.
- **Agent dies** → next topic message re-spawns (status posted into the topic).
- **Two messages during `spawning`** → queued; the second injects once `bound` (no double-spawn).
- **Staleness / sender allow-list / at-most-once offset** semantics are unchanged — topic updates
  ride the same `stepUpdates` offset discipline.
- **Security**: spawning runs `claude` in a user-chosen path — same trust boundary as the human
  starting it; the sender allow-list still gates who can drive the bot.

## 11. Known deferrals (vs the flat path) — to close in later increments

- **Reply quote-anchor (increment 3).** The flat path builds a `↩ «…»` quote anchor from
  `reply_to_message`/`quote`; `topic-route` currently wraps prose plainly. A reply to a specific
  message INSIDE a topic therefore loses the quoted context the flat mode shows. Bring the
  anchor into `topic-route` when threaded replies land for topics.
- **Daemon-level slash commands inside a topic (increment 2).** In a bound topic every slash
  command is injected verbatim into the topic's agent (so `/compact`, `/stop` reach it). That is
  intentional — the topic IS the address — but the DAEMON-level verbs (`/status`, `/agent`,
  `/new`) thus reach the agent as literal text instead of being handled by the daemon. A
  per-topic command filter (or routing `/status`/`/new` to the daemon) is an increment-2 polish.
- **Topic rename name persistence (increment 2).** `forum_topic_edited` is swallowed (no
  mis-route) but the new name is not yet persisted into `TopicBinding.name`, so the tmux-window
  slug can go stale after a rename — the entrypoint should update it.

# tg-cli — /agent addressing (item 1)

Repo: `~/.files/repos/tg-cli`. Pure logic in `features/tg-ctl/agent-match.ts`,
tests in `tests/agent-match.test.ts` + `tests/ctl-agent-route.test.ts`. Daemon
wiring in `tg-ctl` (`listAgentCandidates`, `handleAgentRoute`,
`handleAgentCallback`); command + callback routing in
`features/tg-ctl/updates.ts`.

## North star

A new inbound command lets you address a **specific** agent from Telegram when
several agents run side by side:

```
/agent [<window>] <message>
```

- `<window>` is fuzzy-matched (phonetic) against tmux window names.
- A confident unique match routes `<message>` straight to that agent's pane.
- Ambiguous / no selector / no match → inline **selection buttons**, grouped by
  tmux session, each carrying the pending message; the tap injects it.
- Bare `/agent` → lists the addressable agents (grouped by session), no routing.

This complements the existing default routing (last-`tg`-sender registration):
`/agent` is the explicit override when last-write-wins is not who you mean.

## Command grammar

`parseAgentCommand(text)` → `{ selector, rest, all }`:

- `selector` = the first whitespace token after `/agent` (a *possible* window),
  or `null` for bare `/agent`.
- `rest` = the message when `selector` IS a window (everything after it).
- `all` = the message when there is NO selector (everything after `/agent`).

The daemon decides which interpretation holds *after* matching, because only it
knows the live window names. Tolerates `/agent@botname` (group chats).

## Phonetic normalization

`phoneticKey(s)`:

1. lowercase + **Cyrillic→Latin transliteration** (so `апи`, `кодекс` match
   `api`, `codex`);
2. strip separators/spaces;
3. sound-equivalences: `ph→f`, `ck→k`, `qu→kw`, `x→ks`, hard `c→k`, `w→v`,
   `y→i`;
4. collapse doubled letters.

`matchWindows(selector, candidates)` scores each candidate against the selector
key — `0` exact · `1` prefix · `2` substring · `3+` within an edit-distance band
(`⌈maxlen/4⌉`) — and returns the tied best matches. `confident` = exactly one
best match → route without asking. The Cyrillic table makes a Russian-typed
selector usable; this is deliberately a *light* fold, not full Metaphone.

## Selection buttons

When a choice is needed, `buildAgentSelectMessage(chatId, candidates, token,
preview)` builds a message whose text lists the candidates grouped by session
(`▸ <session>` then `  <window> · <agent>`) and one inline button per candidate
labelled `<window> · <agent>`. Callback data is `tga:<token>:<index>` (index
into the candidate list). `token` keys the daemon's `pendingAgent` store
(message + candidate subset + button message id), TTL 10 min.

A tap (`tga:…`) is parsed by `parseAgentCallback` and emitted as an
`agent-callback` action; the daemon looks up the token, injects the pending
message into `candidates[index]`'s pane (re-verifying the pane still hosts an
agent), answers the callback, and edits the prompt to `→ <window> · <agent>`.

`tga:` callbacks are routed BEFORE `tgq:` (q→buttons) in `stepUpdates`, so the
two button systems never collide.

## Discovery (daemon)

`listAgentCandidates()` runs the same `snapshot()` (panes + process tree) the
target picker uses, finds every pane hosting an agent (`findAgentInPane`), and
fetches window names in a **separate** `tmux list-panes -F '#{pane_id}\t#{window_name}'`
call. The core `PANE_FORMAT` / `parsePaneList` (relied on by inject + q→buttons)
is intentionally left untouched; a pane with no name falls back to its session
name.

## Edge cases

- **No agents** → `NO_AGENT_REPLY`.
- **Single agent + a message** → injected directly, no buttons (asking would be
  silly).
- **Confident match but empty message** (`/agent feat-bot`) → reply naming the
  match and asking for the message; nothing injected.
- **Selector matches nothing** → the whole text is treated as the message and
  buttons are shown over ALL agents.
- Injection always goes through `buildTextInjectPlan` (verify-pane → literal /
  bracketed-paste → paced Enter), so a pane that lost its agent is refused, not
  executed as a shell command.

## Non-goals / future

- No two-step "pick then type" flow — a bare `/agent` only lists; routing always
  carries the message up front.
- No persistence of `pendingAgent` across a daemon restart (10-min in-memory TTL).
- Live end-to-end requires an inbound tap from the chat owner (the unit + step
  tests cover the logic; the button round-trip is the same mechanism as
  q→buttons, which has integration coverage).

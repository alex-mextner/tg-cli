# Decomposition — agent routing, reply quotes, prefix styling, compound autolinks (v1.6.0)

Retrospective decomposition of the v1.6.0 work. **Process note, stated plainly:**
this shipped as **one bundled branch/PR (`feat/agent-routing`, PR #10)**, not as
separate per-feature PRs. That was a decomposition miss — the workstreams below
are independent enough that ~6 PRs would have been cleaner to review and revert.
This document is the decomposition that should have framed it up front; it now
serves as a map of the merged change. Future multi-feature work gets one PR per
workstream.

## Source goal

A 7-item request, then three follow-up asks during execution:

Original (7):
1. `/agent [<win>] <msg>` — address a specific agent; fuzzy window match with
   phonetic normalization; session-grouped buttons when ambiguous.
2. Reply with a partial quote forwarded into the agent.
3. On reply, attach `«date time + start of message …»` as the quote anchor.
4. Verify q→buttons works; document prerequisites.
5. tmux window name in `[]` → bold Unicode (sans-serif); task title → italic/script
   Unicode; `<b>`/`<i>` fallback for Cyrillic.
6. WhatsApp integration (spec).
7. Compound autolink refs: `[#]XXX-ddd/ddd/ddd`, ranges with `..`/`…`/`-`/`,`.

Follow-ups:
8. Make q→buttons seamless (installer + payload normalization) across harnesses;
   defer inbound while an agent is waiting on a question (emoji on the message).
9. Reply to an UNRECOGNIZED message → window picker ordered by LRU+MRU.
10. (separate repo) Fix `review --brainstorm` — it died mid-run; standard log dir.

## Workstreams (the PRs it should have been)

Dependency order: pure/outbound first (no daemon coupling), then inbound daemon,
then the cross-cutting q→buttons completion.

| # | Workstream | Items | Where | Depends on |
|---|---|---|---|---|
| A | Unicode prefix styling | 5 | `features/prefix-style/`, `tg` `buildPrefix`/`renderText`, `applyAutolink` styleTitle | — |
| B | Compound autolink refs | 7 | `features/autolink-refs/compound.ts`, both autolink features, `tg` | — |
| C | `/agent` fuzzy addressing | 1 | `features/tg-ctl/agent-match.ts`, `tg-ctl` handlers, `updates.ts` | — |
| D | Reply quotes | 2, 3 | `updates.ts` `buildReplyInject`, types | — |
| E | Reply routing + LRU/MRU picker | 9 | `features/tg-ctl/routes.ts`, `tg` route recording, `handleReplyRoute` | C, D |
| F | q→buttons seamless + defer | 4, 8 | `hook-normalize.ts`, `hook-install.ts`, `tg-ctl install-hooks`, defer logic | C |
| G | WhatsApp transport (spec only) | 6 | `docs/specs/whatsapp-transport.md` | — |
| H | review-cli brainstorm fix | 10 | separate repo `~/xp/review-cli` (PR #2) | — |

A, B, G are pure/outbound and independently shippable. C–F are the inbound-daemon
cluster; E and F build on C (the `/agent` picker + pane discovery) and D (the
reply quote). H is a different repo entirely.

## Specs (the authoritative per-workstream design)

- A → `docs/specs/unicode-prefix-styling.md`
- B → `docs/specs/autolink-compound.md`
- C → `docs/specs/agent-addressing.md`
- D, E → `docs/specs/reply-quotes.md`
- F → `docs/q-buttons-prerequisites.md`
- G → `docs/specs/whatsapp-transport.md` (+ research `docs/research/2026-06-11-whatsapp-transport.md`)

## Key decisions

- **Item 5 fonts (user-chosen):** window → Mathematical Sans-Serif Bold; task
  title → Mathematical Bold Script; `<b>`/`<i>` fallback because the math blocks
  have no Cyrillic.
- **Item 7 (user-chosen):** body links only WRITTEN numbers (range endpoints), the
  bottom block enumerates the full range (cap 100/step). `/`+digit is a list, but a
  path suffix (`.ts`, `:10`) keeps a file mention a file mention.
- **Reply routing:** recognized → origin pane (validated by cwd — a reused pane id
  must not leak a reply cross-project); unrecognized → LRU/MRU picker.
- **Defer reaction:** ✍️, because Telegram's allowed reaction set has no ⏳.
- **WhatsApp:** spec only — needs the user's Meta Business assets + a webhook
  tunnel; cannot be built/tested here.

## Verification

- 579 `bun test` (all green). Pure modules unit-tested; daemon wiring load-checked
  + covered by the existing integration harness.
- Codex review on each major slice; findings fixed (autolink path false-positive;
  `/agent` stale-tap + failed-send; media-send routes + LRU/MRU order; reply
  cross-project cwd guard — the last surfaced by `review --brainstorm`).
- Live smoke sends proved items 5 + 7 (Telegram accepted the markup).

## Status

All merged + deployed: tg-cli `main` at the PR #10 merge (v1.6.0, live via the
`~/.files/bin/tg` symlink); `tg-ctl install-hooks` run; review-cli PR #2 merged.
Open follow-ups (documented, not built): Claude canary e2e for AskUserQuestion
contract drift; Codex/opencode hook auto-write; the claude-p inner-exec ARG_MAX
ceiling (review-cli warns, doesn't fully lift it).

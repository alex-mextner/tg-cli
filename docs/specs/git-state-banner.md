# tg-cli — git-state-check banner

Repo: `~/.files/repos/tg-cli`. Pure logic in `features/tg-ctl/git-state.ts`, tests in
`tests/ctl-git-state.test.ts` (pure), `tests/ctl-git-state-banner-integration.test.ts` (real
daemon + real git fixtures, tmux/ps shimmed). Config toggle in `features/tg-ctl/config.ts` /
`features/tg-ctl/types.ts`, tests in `tests/ctl-config.test.ts`. Entrypoint wiring
(`gitStateForPath`, `withGitStateBanner`) in `tg-ctl`, adjacent to `injectViaTarget`.

## Incident this fixes

A subagent working an unrelated task on HYP-915 appeared to "silently drop it" for six hours.
Root cause: `tg-ctl` routes an inbound message to a tmux **pane**, not to "the agent's current
task". A fresh message about a different topic landed in the same pane that was mid-flight on
HYP-915; the pane — human or AI, Claude or Codex — has no signal that this is a NEW thread rather
than a continuation, and just reads it as the next line of the same conversation.

Several fixes were considered (per-task session isolation, a stricter routing model, …). This
implements the harness-agnostic one ("Вариант В"): a warning banner prepended to the delivered
message when the destination pane looks mid-flight, so whoever/whatever receives it gets an
explicit signal instead of silence.

## What the check does — and what it does NOT do

`isPaneOccupiedWithWork` (git-state.ts) treats a pane's cwd as "occupied with feature work" when
**either**:
- `git status --porcelain` is non-empty (uncommitted changes), **or**
- the current branch is not `main`/`master` (a clean feature-branch checkout is still someone's
  deliberate work in progress, even with nothing staged right now).

This detects **"this pane's cwd is mid-flight"**, not **"this message is off-topic"** — those are
not the same thing. An agent that always works on a feature branch will see the banner on
**every** delivery to that pane; this is the check's expected shape, not a bug. It is a heads-up
nudge, not a hard gate — it never blocks or drops the message, only prepends operational prose
for the receiving pane. The banner text is not a machine-readable routing API.

## Banner text

```
⚠ This pane currently has uncommitted work on branch feat/foo (3 files changed). Routing check: if this message is about another project, clarify with the user before taking it here. If it clarifies an active task, route it to that active subagent. If it is a new task, start a new subagent.
```

A clean-but-non-main-branch pane gets a variant that doesn't falsely claim "uncommitted work":

```
⚠ This pane is currently on branch feat/foo (not main/master, tree clean). Routing check: if this message is about another project, clarify with the user before taking it here. If it clarifies an active task, route it to that active subagent. If it is a new task, start a new subagent.
```

`buildGitStateBanner(state)` returns `null` (no banner at all) when `state` is `null`
(undeterminable: not a git repo, `git` missing, spawn error/timeout) or the pane is clean on
`main`/`master`.

## Where it's wired — and where it's deliberately NOT

`gitStateForPath(cwd)` (in `tg-ctl`) runs `git -C <cwd> rev-parse --abbrev-ref HEAD` then
`git -C <cwd> status --porcelain`, each spawn killed after 2s (`GIT_STATE_TIMEOUT_MS`) so a stuck
`git` — lock contention, a huge repo, a hung network filesystem — can never block the daemon's
single-threaded poll loop. Any failure degrades to `null` (no banner), the same "never breaks
delivery" contract every other best-effort read in the entrypoint follows.

`withGitStateBanner(panePath, text)` composes the banner and is called **only** at the three
**silent auto-bind** deliveries inside `injectViaTarget` — the un-anchored path where a fresh
message lands on a discovered pane with nothing else choosing it for it:
- a plain non-reply text message (`inject-text` — the exact HYP-915 shape),
- a non-reply photo/document notice (`download-media`),
- a standalone (non-reply) voice transcript (`transcribe-voice`).

**Slash-command passthrough guard (review catch on PR #153):** the flat `inject-text` action also
carries an unrecognized `/command` (e.g. `/compact`, `/clear`) **verbatim, unwrapped** — not the
normal wrapped-prose case — so the harness TUI can execute it as a real slash command. Prepending
the banner ahead of it would push the leading `/` off the first character, so the harness would
read the whole thing as plain prompt text instead of a command. `withGitStateBanner` therefore
skips the banner whenever `text` already starts with `/` — the wrapped-prose case never does (the
`injectWrap` template always renders first), so this only ever catches a real passthrough. Covered
by `tests/ctl-git-state-banner-integration.test.ts`'s dirty-pane passthrough test.

Deliberately **excluded**, with the reasoning at each call site:
- **reply-route** — anchored to a specific prior message; on-topic by construction.
- **topic-route** (forum-topics mode) — a per-topic pane, a different targeting model entirely;
  the topic itself is the disambiguator.
- **`/new` spawns** — a brand-new pane has no prior work to protect.
- **picker taps** (`/agent`, the ambiguous-route picker) — a human already chose that exact pane.
- **a harness control-command passthrough** (e.g. a `/compact` typed mid-`/new`-flow) — a control
  verb, not new content.
- **messages deferred behind an open question** — flushed through `driveFlush`, a separate code
  path; out of scope for this pass.

`injectViaTarget`'s `buildPlan` callback was changed to receive the resolved `TargetPane` (not a
bare `paneId` string): the banner needs `panePath` (the pane's cwd), and that only exists on the
`TargetPane` the function already resolved via `discover()`/`discoverForInject()` — re-deriving it
from a bare paneId (a second `snapshot()`) would race against, and could disagree with, the pane
the message actually lands in.

## Config

`control.git_state_banner` (default **ON**), same `control:` YAML block as `topics` /
`private_topics`. Set `false` to opt out per machine if the noise (see above) isn't worth it.

## Explicitly out of scope for this pass

- The defer-while-waiting flush path (a message queued behind an open question, delivered later
  by `driveFlush`) does not get the banner.
- Forum-topics mode's per-topic bound delivery does not get the banner (different targeting
  model; a topic is itself a disambiguator that the flat 1:1 mode lacks).
- This is a nudge, not a fix for the routing model itself — it does not change WHICH pane a
  message lands on, only what the pane is told when it does.

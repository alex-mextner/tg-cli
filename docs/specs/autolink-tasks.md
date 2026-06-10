# tg-cli — autolink-tasks feature spec

Repo: `~/.files/repos/tg-cli`. Feature lives in `features/autolink-tasks/`, tests in
`tests/autolink.test.ts`. Built on top of the auto-attach architecture (feature flags,
`renderText` hook, post-render SendPlan transforms).

## North star

Ticket-like codes in the message text (e.g. `HYP-576`) are verified against Linear via
the `linear` CLI (schpet/linear-cli) and turned into links. The ticket title is surfaced:
on the first line for a single ticket, as a collapsed reference block for several.
ON by default, toggled like any feature: `--no-feature autolink-tasks` or
`features: { autolink-tasks: false }` in `~/.config/tg-cli/config.yaml`.

## Detection

- A ticket code is exactly **3 uppercase Latin letters, a dash, then digits**, written
  as one token: `[A-Z]{3}-[0-9]+`.
- Boundaries: the char before/after the match must not be alphanumeric — `XHYP-576`,
  `HYP-576a` are NOT codes; `(HYP-576)`, `HYP-576,`, `HYP-576.` are.
- Tokens containing `://` are skipped entirely: a pasted URL
  (`https://linear.app/glide-vc/issue/HYP-576/slug`) must never be linkified inside.
- A code embedded in a file-path-looking token is a FILE mention, not a ticket:
  `HYP-123.ts:10`, `src/HYP-124/x.ts` are skipped (this also keeps line-spec quote
  anchors contiguous — codex review finding). A trailing sentence period
  (`fixed HYP-576.`) still counts.
- Codes are deduplicated preserving first-appearance order.
- Detection runs on the decoded caption (after `\n` escapes), BEFORE extraction/render.
  The tmux `[window]` prefix is NOT scanned (metadata, not message text).

## Verification (linear CLI)

One `linear api '<GraphQL>'` spawn per send, only when detection found codes:

```
query { issues(filter: { or: [
  { and: [ { team: { key: { eq: "HYP" } } }, { number: { in: [576, 99999] } } ] },
  ...one and-clause per team key...
] }, first: 250) { nodes { identifier title url } } }
```

- Codes are grouped by team key; numbers with >9 digits are dropped (parseInt precision;
  no real Linear issue number is that long).
- Issues missing in Linear simply don't come back → those codes are **ignored** (stay
  plain text). This also survives the aliased-`issue(id:)` pitfall: a single missing id
  there nukes the whole response (`data: null`), the filter query does not.
- Spawn timeout 10s; on timeout/any unexpected failure the message is sent UNCHANGED
  with a one-line stderr warning. Autolink must never block or fail a send.

### CLI missing / not authenticated → hint ONCE

- Spawn fails (binary not found) → stderr hint to install:
  `brew install schpet/tap/linear` (NOT bare `brew install linear` — that's the desktop
  app cask). Shown ONCE ever, recorded in `~/.config/tg-cli/autolink-tasks.json`
  (`{"install": true}`).
- Exit ≠ 0 with `No API key configured` / `No workspaces configured` in output → stderr
  hint to run `linear auth login`. Also shown once (`{"login": true}`).
- The hint state file is best-effort: unreadable/corrupt → treated as empty; write
  failures are swallowed.
- In both cases the message is sent unchanged.

## Rendering (post-render transform, like line-spec quotes)

When ≥1 detected code resolves to a real ticket, the render is forced to HTML (same
mechanism as `hasQuotes`: plain prose gets `&<>`-escaped). The transform then runs on
`plan.textMessages[0]` — which also covers the media-caption ride, since the transmitter
promotes that same message to a caption. It runs BEFORE line-spec quote insertion so
injected `<pre>` quote bodies are never linkified.

1. **Linkify**: every occurrence of a verified code in text segments becomes
   `<a href="URL">CODE</a>`. Skipped inside existing tags, inside `<a>…</a>` text
   (no nested links), inside `<pre>`/`<code>` (Telegram forbids nested entities),
   and inside `://` tokens.
2. **Single ticket** → its title goes on the FIRST line:
   - with an `<emoji> [window]` prefix line: appended to that line — `✳️ [win] Title`;
   - without a prefix: the title becomes its own first line above the text.
   Title is HTML-escaped.
3. **Several tickets** → a collapsed reference block appended at the end:
   `<blockquote expandable>` with one `<a href>CODE</a>: title` line per ticket, in
   first-appearance order.

Edge cases:
- All prose stripped by R2/R4 → no text message → transform skipped silently.
- A code whose only mention sat inside an extracted (R4) block: linkify finds no
  occurrence (no-op), but the title line / reference block still applies — the ticket
  WAS mentioned in the original text.
- Window name containing a verified code gets linkified too (harmless, deliberate).

## Non-goals

- No write operations against Linear, ever.
- No scanning of attachments' contents.
- Lowercase codes (`hyp-576`) are not tickets.
- No second hint after the first (per kind), even across months.

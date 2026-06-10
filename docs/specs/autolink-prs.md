# tg-cli — autolink-prs feature spec

Repo: `~/.files/repos/tg-cli`. Feature lives in `features/autolink-prs/`, tests in
`tests/autolink-prs.test.ts`. Sibling of `autolink-tasks` (docs/specs/autolink-tasks.md):
the same detection → verify → cache → render pipeline, but for GitHub `#N` references
instead of Linear ticket codes. The two features compose — a single message can carry
Linear tickets, GitHub issues, and GitHub PRs at once.

## North star

GitHub-style references in the message text (e.g. `#260`) are verified against the
GitHub repo the send was launched from (via `gh`) and turned into links. The reference
title is surfaced in a collapsed reference block at the END of the message. Crucially,
GitHub `issueOrPullRequest(number:)` resolves a `#N` to EITHER an Issue or a Pull Request:

- **Issues** are merged INTO the `autolink-tasks` ticket reference block (issues and
  tickets are "work items" — they read the same way: `#260 — Title`).
- **Pull requests** ALWAYS get their OWN separate collapsed block, placed AFTER the
  tickets/issues block, even for a single PR (`PRs:` header, with a state annotation
  like `(merged)` / `(draft)`).

ON by default, toggled like any feature: `--no-feature autolink-prs` or
`features: { autolink-prs: false }` in `~/.config/tg-cli/config.yaml`.

## Detection

- A reference is a `#` immediately followed by digits, written as one token: `#[1-9][0-9]*`.
  `#0` is not a thing on GitHub — the leading digit must be `1-9`.
- Boundaries: the char before/after the match must not be alphanumeric — `x#1`, `#1a` are
  NOT references; `(#260)`, `#260,`, `#260.` are. (Mirrors the ticket boundary rules.)
- Tokens containing `://` are skipped entirely: a pasted GitHub URL
  (`https://github.com/owner/repo/pull/260`) must never be linkified inside.
- References are deduplicated preserving first-appearance order (by number).
- Detection runs on the decoded caption (after `\n` escapes), BEFORE extraction/render.
  The tmux `[window]` prefix is NOT scanned (metadata, not message text).

## Verification (gh CLI)

Two `gh` spawns per send, only when detection found references, all via an injected
`Runner` (tests pass a fake; the tg entrypoint passes a `Bun.spawnSync` wrapper run from
the send's cwd):

1. **Repo identity**: `gh repo view --json nameWithOwner -q .nameWithOwner` — the
   `owner/name` the cwd resolves to. Run first; if it fails there is no repo to query.
2. **Batch resolve**: ONE `gh api graphql -f query='...'` spawn resolving every detected
   number at once via aliased fields:

```
query {
  repository(owner: "OWNER", name: "NAME") {
    n260: issueOrPullRequest(number: 260) {
      __typename
      ... on Issue { number title url state }
      ... on PullRequest { number title url state isDraft }
    }
    n42: issueOrPullRequest(number: 42) { ... }
  }
}
```

- `issueOrPullRequest(number:)` errors per-field for a missing number — GraphQL returns a
  partial `data` object (the missing alias is `null`) PLUS a top-level `errors` array.
  This is handled gracefully: present aliases resolve, `null`/errored aliases are negative
  verdicts (the `#N` stays plain text). A whole-response failure (`data: null`) is an error.
- Each resolved ref carries its `__typename` (`Issue` | `PullRequest`), title, url, state,
  and — for PRs — `isDraft`.
- Spawn timeout 10s; on timeout/any unexpected failure the message is sent UNCHANGED with a
  one-line stderr warning. Autolink must never block or fail a send.

### Degradation (mirrors autolink-tasks linear.ts)

Every failure mode is a distinct status and keeps the send going as plain text:

- **no-cli** — `gh` binary not found (spawn returns null). One-time stderr hint to install:
  `brew install gh`.
- **no-auth** — `gh` output mentions authentication (`gh auth login` / `authentication`
  markers). One-time stderr hint to run `gh auth login`.
- **no-repo** — `gh repo view` fails because the cwd is not a git repo or has no GitHub
  remote. Silent (no hint — not actionable, and a non-GitHub cwd is normal); the send
  proceeds plain.
- **error** — anything else (network, malformed response): one-line stderr warning.

The one-time hints REUSE the existing `autolink-tasks` hint-state mechanism
(`features/autolink-tasks/state.ts`, file `~/.config/tg-cli/autolink-tasks.json`). The
`HintKind` union is extended with `'gh-install'` and `'gh-login'`; the state-file parser
stays backward-compatible (old `{install,login}` files still parse).

## Caching (mirrors autolink-tasks cache.ts)

- File: `~/.cache/tg-cli/gh-cache.json` (separate from `linear-cache.json`).
- TTL: **1 hour** per entry.
- Both **positive** (resolved ref stored) and **negative** (confirmed-absent) verdicts are
  cached — a missing `#N` is not re-probed every send.
- **CRITICAL — cache key includes the repo**: the key is `<owner>/<repo>#<number>`. The
  same `#260` means a different thing in a different repo, so a bare `#260` key would be a
  correctness bug. The repo identity from step 1 is folded into every key.
- Cache shape: `{ entries: { "<owner>/<repo>#<N>": { t: <unix ms>, info: GhRef | null } } }`.
  Expired entries are pruned on write. Read/write failures degrade silently to a live probe.

## Rendering (post-render transform)

When ≥1 detected reference resolves, the render is forced to HTML (same mechanism as
`hasTickets`/`hasQuotes`). The transform runs on `plan.textMessages[0]` BEFORE line-spec
quote insertion. Both plain-text and `--format html` sends are supported identically — the
forced-HTML body is already escaped by the time the transform runs, exactly like
autolink-tasks.

1. **Linkify**: every occurrence of a verified `#N` in text segments becomes
   `<a href="URL">#N</a>` — Issues and PRs alike. Uses the same segment-safety walk as
   autolink-tasks (no linkify inside `<a>`, `<pre>`/`<code>`, tag attributes, or `://`
   tokens). The autolink-tasks `linkifyCodes` segment walker is reused via a shared
   linkify over a generic ref table.
2. **Issues → tickets block**: resolved issues are appended to the SAME collapsed
   `<blockquote expandable>` that autolink-tasks builds for its tickets, formatted
   `<a href>#260</a> — Title`. Tickets come first (first-appearance order), then issues
   (first-appearance order). If there is exactly one ticket and zero issues, the
   single-ticket "title on the first line" behavior of autolink-tasks is unchanged; a
   present issue forces the block form (issues never go on the first line).
3. **PRs → own block**: resolved PRs ALWAYS get a separate collapsed
   `<blockquote expandable>` AFTER the tickets/issues block, even for a single PR:
   `PRs:` on the first line, then one `<a href>#N</a> — Title (state)` line per PR in
   first-appearance order. State annotation: `(merged)` / `(closed)` / `(draft)` for an
   open draft / `(open)`.

Both the issue→tickets merge and the PR block are produced by extending the autolink-tasks
`applyAutolink` contract so the two features compose in one pass over the body.

## Non-goals

- No write operations against GitHub, ever (read-only `gh api graphql` / `gh repo view`).
- No scanning of attachments' contents.
- `#0` and non-numeric `#x` are not references.
- No cross-repo references — `#N` is always resolved against the send's cwd repo only.
- No second hint after the first (per kind), even across months.

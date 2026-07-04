# tg-cli — autolink-msgrefs feature spec

Repo: `~/.files/repos/tg-cli`. Feature lives in `features/autolink-msgrefs/`, tests in
`tests/autolink-msgrefs.test.ts`. Sibling of `autolink-prs` (docs/specs/autolink-prs.md)
in shape, but for inbound **Telegram message** references — `tg#<id>` — not GitHub `#N`.

## North star

The inbound inject wrap renders an inbound message's id as `tg#<id>`
(`[TG from Alex tg#1234] …`, see `features/tg-ctl/inject.ts`). When an agent quotes that
id back in an outbound message ("answered tg#1234", "see tg#1234"), it means *the Telegram
message with id 1234* — NOT a GitHub issue/PR `#1234`.

The `tg#` prefix is the whole disambiguation. A bare `#1234` belongs to `autolink-prs`
(resolved against the cwd GitHub repo). Without the prefix the two namespaces collide:
`#3715` quoted from a phone would be probed against `gh` and mis-linked as PR/issue #3715.
The convention fixes that at the source — ids are *written* as `tg#<id>`, and this feature
links them.

ON by default, toggled like any feature: `--no-feature autolink-msgrefs` or
`features: { autolink-msgrefs: false }` in `~/.config/tg-cli/config.yaml`.

## Detection (`detect.ts`)

- A reference is `tg#` (case-insensitive on `tg`) immediately followed by a positive id:
  `tg#[1-9][0-9]*`. `tg#0` is not a thing — the leading digit must be `1-9`.
- The already-rendered bold-italic form `𝒕𝒈#<id>` / `𝑻𝑮#<id>` is also accepted. This
  matters in private DMs, where message refs render as styled-but-unlinked text and users
  often copy that visible token back verbatim.
- Boundaries: the char before `tg` and the char after the number must not be alphanumeric.
  `xtg#1`, `tg#1a` are NOT references; `(tg#10)`, `tg#10,`, `tg#10.` are.
- Whitespace tokens containing `://` are skipped (a pasted URL with `tg#` in its path is not
  a plain-text mention — same guard as autolink-prs).
- `detectMsgRefs(text)` → unique ids in first-appearance order.

## Linking (`render.ts`)

- `msgRefUrl(chatId, id)` builds a `t.me` deep link **only for a supergroup/channel** chat
  (`-100<rest>` → `https://t.me/c/<rest>/<id>`). A private bot DM (a positive chat id) or a
  basic group has NO public per-message URL → `null`.
- `linkifyMsgRefs(html, urlFor)` rewrites each `tg#<id>` in an already-rendered HTML body:
  - url present → `<a href="t.me/c/…">tg#<id></a>`;
  - url null → a marked-but-unlinked **bold-italic** styled reference (so it still reads as
    a deliberate reference, not stray text). The dominant case — the user's private DM — is
    the null case.
- Same tag-safe walk as the sibling features: never rewrites inside `<a>…</a>` (Telegram
  rejects nested links), `<pre>`/`<code>`, or a token containing `://`.
- When a mentioned message id exists in the local `tg replies` history, `buildMsgRefEntries`
  contributes a bottom `<blockquote expandable>` entry. The label is the same link/styled
  `tg#<id>` marker; the title is `from: head`, where `head` is a one-line collapsed excerpt
  truncated to a short prefix with `…`. The outbound message never quotes the whole referenced
  Telegram message.
- Excerpt entries are keyed from the same tag-safe walk as linkification, not from raw text:
  `tg#<id>` inside `<a>`, `<pre>`, `<code>`, or a URL token does not link and does not add an
  excerpt block.
- New history rows carry `chat_id`, and excerpt lookup filters by the current chat so the same
  bot used in two chats cannot show another chat's message text for a colliding `message_id`.
  Legacy rows without `chat_id` remain eligible for backward compatibility.
- Missing/corrupt history is best-effort: link/styled body refs still render, but the excerpt
  block entry is skipped.

## Ordering — runs BEFORE the #N PR pass

In the `tg` outbound transform, `linkifyMsgRefs` runs FIRST, before `applyAutolink`'s
ticket/`#N` linkifiers. The resulting `<a>`/styled span is then skipped by those passes
(they don't rewrite inside `<a>`), and a `tg#3715` is never offered to the gh probe. In
practice the PR detector's own boundary rule already rejects `tg#3715` (the `g` before `#`
is alphanumeric), so the two are naturally disjoint; running msgrefs first makes that
explicit and robust to any future loosening of the PR boundary rule.

## Tests (TDD, red-first)

- detect: bare `tg#<id>`; case-insensitive prefix; dedup + first-appearance order;
  already-styled `𝒕𝒈#<id>`; punctuation boundaries; leading/trailing alnum rejection;
  `tg#0` rejection; bare `#N` is NOT a msgref; URL tokens skipped; multiline; empty.
- `msgRefUrl`: supergroup → `t.me/c` link; DM/basic-group/empty → null.
- linkify: url → anchor; null url → styled bold-italic ref; tag-safety inside
  `<a>`/`<pre>`/`<code>`/URL tokens; no-ref body unchanged.
- excerpt entries: compact one-line history excerpt, ellipsis on truncation, missing ids
  skipped, duplicate ids deduped in mention order, code-point-safe emoji truncation, escaped
  excerpt text, and current-chat filtering when `chat_id` is available.
- entrypoint subprocess: real `tg` send against a fake Bot API reads
  `tg-ctl.<bot>.history.jsonl` and sends the excerpt block for both `tg#<id>` and
  `𝒕𝒈#<id>`; skipped tags do not create excerpt-only blocks.
- coexistence: `detectRefs` ignores `tg#<id>`; the PR linkify never rewrites a `tg#<id>`
  even when that number is a verified PR, while a standalone `#N` still links.

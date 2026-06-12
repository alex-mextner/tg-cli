# tg-cli — Unicode prefix styling (item 5)

Repo: `~/.files/repos/tg-cli`. Code in `features/prefix-style/style.ts`, tests in
`tests/prefix-style.test.ts`. Wired into the `tg` outbound prefix (`buildPrefix`,
`renderText`) and into `applyAutolink` (`features/autolink-tasks/render.ts`).

## North star

The message prefix `<emoji> [window] <task title>` gets typographic styling:

- the **tmux window name** inside `[]` → **Mathematical Sans-Serif Bold**
  (`[𝗮𝗽𝗶-𝗯𝗼𝘁]`) — "math but no serifs" (decision 2026-06-12);
- the **single-ticket task title** appended after `]` (the autolink-tasks
  first-line title) → **Mathematical Bold Script** (`𝓕𝓲𝔁 𝓪𝓾𝓽𝓸𝓵𝓲𝗻𝗸`), a
  calligraphic italic.

The brackets themselves stay unstyled; the emoji is untouched (branded custom
emoji as before).

## Why a fallback is mandatory

The Mathematical Alphanumeric Symbols blocks only cover ASCII **A–Z / a–z** (and,
for sans-serif, digits). They contain **no Cyrillic**, no accented Latin, no
Greek. A window/title that carries such a letter cannot be styled with Unicode at
all, so it falls back to a real HTML tag:

- window name with a non-Latin letter → `<b>name</b>` (escaped);
- task title with a non-Latin letter → `<i>title</i>` (escaped).

Digits and punctuation never trigger the fallback — they are left verbatim inside
an otherwise-styled token (Bold Script has no digit glyphs, so `Fix v2` keeps its
plain `2`). The fallback trigger is precisely "contains a Unicode letter that is
not ASCII `A–Z/a–z`".

## Module API (`features/prefix-style/style.ts`)

- `toSansBold(s): string | null` — map ASCII letters+digits to Sans-Serif Bold;
  `null` when `s` has a foreign letter.
- `toBoldScript(s): string | null` — map ASCII letters to Bold Script (no
  digits); `null` on a foreign letter.
- `styleWindowName(name): { html, plain, tag }` — `html` is escaped (and may be
  `<b>name</b>`), `plain` is the unicode-only form, `tag` is true when `html`
  carries a real tag (forces HTML mode).
- `styleTaskTitle(raw): string` — final HTML for the title (unicode script
  escaped, or `<i>…</i>`). Used as the `styleTitle` hook of `applyAutolink`.

## Render wiring (`tg`)

`buildPrefix()` now returns `{ html, plain, present, forceHtml }`:

- `html` — the finished prefix HTML: branded emoji → `<tg-emoji>`, window →
  styled (escaped). `plain` — the unicode-only form for the non-HTML path.
- `forceHtml` — true when a custom-emoji tag or the `<b>` window fallback is
  present, so the whole message must be sent as HTML.
- `present` — replaces the old `prefix.text.length > 0` signal.

`renderText` decides `userHtml` from the **caption alone** (the emoji tag and
styled `[window]` are ours, not user-authored HTML), renders+escapes the caption
independently, then prepends the trusted `prefix.html` (or `prefix.plain`). This
is the key change that lets a `<b>` window fallback coexist with an escaped
plain-text caption — the previous single binary escape flag could not.

`applyAutolink` takes an optional `styleTitle` (default `escapeHtml`, so existing
callers are unchanged); `tg` passes `styleTaskTitle`. The script title only
applies in the single-ticket "title on the first line" branch — the multi-ticket
block keeps plain escaped titles.

## Non-goals

- No styling of the message body or the emoji.
- No Cyrillic "pseudo-bold" via combining marks — `<b>`/`<i>` is the honest
  fallback.
- Multi-ticket reference-block titles are not script-styled (only the single
  first-line title is the "task name after []").

## Caveats

- Math-styled text is poor for screen readers and copy-paste — an explicit
  aesthetic trade chosen by the user.
- Telegram renders these code points fine; the entity offsets in `tg` are UTF-16
  based, and the styled window carries no custom-emoji entity, so surrogate-pair
  widths are irrelevant to offset math.

// --- Formatting reference (`tg --format-help`) ---
//
// A concise, copy-pasteable reference for what Telegram message formatting
// ACTUALLY supports, so agents stop guessing. Grounded in the June 2026 Bot API:
// a fixed HTML-tag allowlist, only four HTML entities, NO <table>, NO <br>.
//
// Pure: FORMAT_HELP is a constant string; formatHelp() returns it so the
// entrypoint stays symmetric with the other --*-help / info actions.

export const FORMAT_HELP = `tg / Telegram message formatting (Bot API, June 2026)

Send HTML with --format html. Only this tag allowlist is supported; everything
else is stripped or rejected by Telegram.

Supported HTML tags (with examples):
  <b>bold</b>            / <strong>bold</strong>
  <i>italic</i>          / <em>italic</em>
  <u>underline</u>       / <ins>underline</ins>
  <s>strike</s>          / <strike>…</strike> / <del>…</del>
  <code>inline code</code>
  <pre>preformatted block</pre>
  <pre><code class="language-ts">const x = 1</code></pre>
  <a href="https://example.com">link</a>
  <blockquote>quoted</blockquote>
  <blockquote expandable>long quote, collapsed by default</blockquote>
  <span class="tg-spoiler">hidden</span>  / <tg-spoiler>hidden</tg-spoiler>
  <tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>   (premium custom emoji)

HTML entities — ONLY these four are recognized. Escape raw chars in your text:
  &lt;  for <      &gt;  for >      &amp;  for &      &quot;  for "
There are NO other named entities (&nbsp;, &copy;, … are sent literally).

NOT supported (common mistakes):
  <table>, <tr>, <td>   — Telegram has NO tables. Use a monospace <pre> instead:
                          run \`tg --table\` (reads TSV / \`a | b\` rows from stdin,
                          auto-sizes columns, box-draws borders, wraps in <pre>).
  <br>                  — line breaks are real newlines (\\n), not a tag.
  <h1>…<h6>, <ul>/<li>, <p>, <div>, style/color attributes — all unsupported.
  <tg-emoji> must wrap EXACTLY ONE emoji as its inner text, or Telegram rejects
  the whole message (ENTITY_TEXT_INVALID).

The <pre> "table" pattern:
  Wrap a padEnd-aligned, box-drawn monospace block in <pre>. \`tg --table\` does
  this for you — pipe rows in:
    printf 'task\\tstatus\\nship\\tdone\\nreview\\twip' | tg --table

Header badge (--tag / --title):
  --title "<text>"   explicit headline on the \`✳️ [window]\` line.
  --tag <TAG>        a labeling pill: ANSWER/DECISION/PROBLEM/REPORT
                     (aliases ОТВЕТ/РЕШЕНИЕ/ПРОБЛЕМА/ОТЧЁТ). Composes with --title.
  --reply-to <id>    thread the message under an inbound Telegram message
                     (sets reply_to_message_id). ANSWER tag REQUIRES this.
`;

export function formatHelp(): string {
  return FORMAT_HELP;
}

// --- Message prefix (branded emoji + styled [window] + optional tag/title) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 1, docs/specs/
// tg-decomposition.md). The main()-side closure captured AI_EMOJI / MODEL /
// the resolved tmux window name; here they arrive as explicit params. The
// returned shape is unchanged: `html` (custom emoji → <tg-emoji>, window name →
// Mathematical Sans-Serif Bold or an escaped <b> fallback) and `plain` (unicode
// only, no tags), plus `forceHtml` (true when the html form carries a real tag,
// so the whole message MUST go out as HTML) and `present`.
//
// The prefix ALWAYS ends with a newline: the message body sits BELOW the header
// line, never joined onto it. The header line is `✳️ [window]`, optionally
// followed by an explicit tag badge and/or an explicit `--title`:
//   ✳️ [window]                          (no tag, no title)
//   ✳️ [window] <title>                  (--title only)
//   ✳️ [window] 🔵 💬 ОТВЕТ              (--tag only)
//   ✳️ [window] 🔵 💬 ОТВЕТ — <title>    (--tag + --title)
// The message body NEVER rides this line — only an explicit tag/title appear.
import { EMBEDDABLE_EMOJI_MAP, extractBaseModel } from '../branding/emoji';
import { styleTaskTitle, styleWindowName, toBoldItalic } from '../prefix-style/style';
import { resolveTag } from './tag';
import { escapeHtml } from './html';

export interface PrefixParts {
  html: string;
  plain: string;
  present: boolean;
  forceHtml: boolean;
}

export function buildPrefix(opts: {
  aiEmoji: string;
  model: string;
  tmuxWindow: string;
  // Explicit message tag (`--tag`). Resolved case-insensitively; English
  // aliases map to the Russian canonicals. Unknown → a soft `[TAG]` badge.
  tag?: string;
  // Explicit header title (`--title`). The message body is NEVER pulled up
  // here; only this explicit title ever appears on the header line.
  title?: string;
}): PrefixParts {
  const { aiEmoji, model, tmuxWindow, tag, title } = opts;
  let html = '';
  let plain = '';
  let forceHtml = false;

  if (aiEmoji) {
    // Resolve the branded custom-emoji id (exact key, then substring match).
    const base = extractBaseModel(model);
    let emojiId = EMBEDDABLE_EMOJI_MAP[base];
    if (!emojiId) {
      for (const [key, id] of Object.entries(EMBEDDABLE_EMOJI_MAP)) {
        if (base.includes(key)) {
          emojiId = id;
          break;
        }
      }
    }
    if (emojiId) {
      html += `<tg-emoji emoji-id="${emojiId}">${aiEmoji}</tg-emoji>`;
      forceHtml = true; // a custom-emoji tag only renders in HTML mode
    } else {
      html += escapeHtml(aiEmoji); // no branded id → plain unicode emoji
    }
    plain += aiEmoji;
  }

  if (tmuxWindow) {
    if (plain.length > 0) {
      html += ' ';
      plain += ' ';
    }
    const styled = styleWindowName(tmuxWindow);
    html += `[${styled.html}]`;
    plain += `[${styled.plain}]`;
    if (styled.tag) forceHtml = true; // the <b> Cyrillic fallback forces HTML
  }

  // --- Optional tag badge (`--tag`) on the header line, after [window]. ---
  if (tag && tag.trim()) {
    const resolved = resolveTag(tag);
    const sep = plain.length > 0 ? ' ' : '';
    // Known: `🔵 💬 ОТВЕТ`. Unknown: a soft `[WORD]` badge (no emoji, no fail).
    const badge = resolved.known ? `${resolved.emoji} ${resolved.word}` : `[${resolved.word}]`;
    html += `${sep}${escapeHtml(badge)}`;
    plain += `${sep}${badge}`;
  }

  // --- Optional explicit title (`--title`) on the header line. ---
  // Styled like the autolink single-ticket title (Bold Italic) for visual
  // consistency. A Cyrillic/foreign title falls back to <i> in HTML (forcing
  // HTML); the plain form keeps the unstyled raw text.
  if (title && title.trim()) {
    const raw = title.trim();
    // With a tag present the title follows ` — `; otherwise just a space.
    const hasTag = !!(tag && tag.trim());
    const sep = plain.length > 0 ? (hasTag ? ' — ' : ' ') : '';
    html += `${sep}${styleTaskTitle(raw)}`;
    plain += `${sep}${toBoldItalic(raw) ?? raw}`;
    // styleTaskTitle wraps a foreign-letter title in <i> → must go out as HTML.
    if (toBoldItalic(raw) === null) forceHtml = true;
  }

  if (!plain && !html) return { html: '', plain: '', present: false, forceHtml: false };
  // The prefix ALWAYS ends with a newline: the body sits BELOW the header line.
  // The body's first line is NEVER joined onto `[window]` (only an explicit
  // --tag/--title ever appears on the header line, handled above).
  return { html: html + '\n', plain: plain + '\n', present: true, forceHtml };
}

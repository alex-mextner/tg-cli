// --- Message prefix (branded emoji + styled [window]) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 1, docs/specs/
// tg-decomposition.md). The main()-side closure captured AI_EMOJI / MODEL /
// the resolved tmux window name; here they arrive as explicit params. The
// returned shape is unchanged: `html` (custom emoji → <tg-emoji>, window name →
// Mathematical Sans-Serif Bold or an escaped <b> fallback) and `plain` (unicode
// only, no tags), plus `forceHtml` (true when the html form carries a real tag,
// so the whole message MUST go out as HTML) and `present`.
import { EMBEDDABLE_EMOJI_MAP, extractBaseModel } from "../branding/emoji"
import { styleWindowName } from "../prefix-style/style"
import { escapeHtml } from "./html"

export interface PrefixParts {
  html: string
  plain: string
  present: boolean
  forceHtml: boolean
}

export function buildPrefix(opts: {
  aiEmoji: string
  model: string
  tmuxWindow: string
}): PrefixParts {
  const { aiEmoji, model, tmuxWindow } = opts
  let html = ""
  let plain = ""
  let forceHtml = false

  if (aiEmoji) {
    // Resolve the branded custom-emoji id (exact key, then substring match).
    const base = extractBaseModel(model)
    let emojiId = EMBEDDABLE_EMOJI_MAP[base]
    if (!emojiId) {
      for (const [key, id] of Object.entries(EMBEDDABLE_EMOJI_MAP)) {
        if (base.includes(key)) {
          emojiId = id
          break
        }
      }
    }
    if (emojiId) {
      html += `<tg-emoji emoji-id="${emojiId}">${aiEmoji}</tg-emoji>`
      forceHtml = true // a custom-emoji tag only renders in HTML mode
    } else {
      html += escapeHtml(aiEmoji) // no branded id → plain unicode emoji
    }
    plain += aiEmoji
  }

  if (tmuxWindow) {
    if (plain.length > 0) {
      html += " "
      plain += " "
    }
    const styled = styleWindowName(tmuxWindow)
    html += `[${styled.html}]`
    plain += `[${styled.plain}]`
    if (styled.tag) forceHtml = true // the <b> Cyrillic fallback forces HTML
  }

  if (!plain && !html) return { html: "", plain: "", present: false, forceHtml: false }
  return { html: html + "\n", plain: plain + "\n", present: true, forceHtml }
}

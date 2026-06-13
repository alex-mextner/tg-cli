// --- HTML render helpers (pure) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 1, docs/specs/
// tg-decomposition.md). All pure: escaping, tag detection, parse-mode
// selection, and the two emoji-entity transforms. parseEmojiHelpers and
// convertEntitiesToHtml read the shared branding maps by reference, so the
// main()-side TG_EMOJI_IDS overrides (which mutate EMBEDDABLE_EMOJI_MAP in
// place) are still observed here — zero behaviour change.
import {
  EMBEDDABLE_EMOJI_MAP,
  UNICODE_EMOJI_MAP,
  type EmojiEntity,
  type ParsedText,
} from "../branding/emoji"
import { type Format } from "../cli/args"

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function detectHtmlTags(text: string): boolean {
  const htmlPattern = /<(b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|a|tg-emoji|tg-time|code|pre|blockquote)\b/i
  return htmlPattern.test(text)
}

export function parseModeFor(formatValue: Format, text?: string): "HTML" | undefined {
  if (formatValue === "html") return "HTML"
  if (text && detectHtmlTags(text)) return "HTML"
  return undefined
}

// Render custom-emoji entities to inline <tg-emoji> tags.
//   escape=false → the surrounding text is intentional HTML (user asked for
//     --format html or wrote real tags); leave it verbatim.
//   escape=true  → we are forcing HTML ONLY to carry the emoji; the
//     surrounding text is plain, so escape &<> in the non-entity segments so
//     literal characters can't break HTML parsing (regression guard).
export function convertEntitiesToHtml(
  text: string,
  entities: EmojiEntity[],
  escape = false,
): string {
  // Walk entities left-to-right, copying the gaps between them verbatim (or
  // HTML-escaped when `escape`) and inserting a <tg-emoji> tag for each.
  const asc = [...entities].sort((a, b) => a.offset - b.offset)
  let out = ""
  let cursor = 0
  for (const e of asc) {
    const gap = text.slice(cursor, e.offset)
    out += escape ? escapeHtml(gap) : gap
    const emoji = text.slice(e.offset, e.offset + e.length)
    out += `<tg-emoji emoji-id="${e.custom_emoji_id}">${emoji}</tg-emoji>`
    cursor = e.offset + e.length
  }
  const tail = text.slice(cursor)
  out += escape ? escapeHtml(tail) : tail
  return out
}

// Substitute :name: helper markers with their custom-emoji placeholder (+ an
// entity carrying the custom_emoji_id) or their plain unicode fallback. Reads
// the shared EMBEDDABLE_EMOJI_MAP / UNICODE_EMOJI_MAP singletons by reference.
export function parseEmojiHelpers(text: string): ParsedText {
  const entities: EmojiEntity[] = []
  let result = ""

  const regex = /:([a-zA-Z0-9_-]+):/g
  let match
  let lastIndex = 0

  while ((match = regex.exec(text)) !== null) {
    const [fullMatch, name] = match
    const lower = name.toLowerCase()
    const emojiId = EMBEDDABLE_EMOJI_MAP[lower]
    const unicodeEmoji = UNICODE_EMOJI_MAP[lower]

    // Append text before match
    result += text.slice(lastIndex, match.index)

    if (emojiId) {
      // Use placeholder emoji for entity
      const placeholder = unicodeEmoji || "🤖"
      entities.push({
        type: "custom_emoji",
        offset: result.length,
        length: placeholder.length,
        custom_emoji_id: emojiId,
      })
      result += placeholder
    } else if (unicodeEmoji) {
      result += unicodeEmoji
    } else {
      result += fullMatch
    }

    lastIndex = regex.lastIndex
  }

  // Append remaining text
  result += text.slice(lastIndex)

  return { text: result, entities }
}

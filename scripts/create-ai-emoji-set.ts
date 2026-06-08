#!/usr/bin/env bun
/**
 * Create a Telegram custom emoji sticker set for AI model icons.
 *
 * Prerequisites:
 *   - Create 512x512 PNG/WebP images under ./assets/ named after models:
 *     claude.png, codex.png, gemini.png, deepseek.png, qwen.png, kimi.png, glm.png
 *   - Set TG_BOT_TOKEN and TG_OWNER_ID env vars
 *   - Run: bun scripts/create-ai-emoji-set.ts --image-dir ./assets
 *
 * The script auto-detects the bot username and creates a set named:
 *   agents_by_<bot_username>
 */

import { readFileSync, existsSync } from "fs"
import { join } from "path"

// MUST stay in sync with the builder CONFIG in build-emoji-icons.py and
// MODEL_EMOJI_MAP in `tg` — every model here must have a generated <model>.png.
const AI_MODELS: Record<string, string> = {
  claude: "✳️",
  codex: "👐",
  copilot: "🦾",
  cursor: "👆",
  deepseek: "🐳",
  gemini: "♊️",
  grok: "🤘",
  hyperide: "🚁",
  kimi: "🌙",
  meta: "🦙",
  mistral: "Ⓜ️",
  ollama: "🦙",
  perplexity: "🔮",
  qwen: "🟣",
  windsurf: "🏄",
}

const SET_NAME = "agents"
const SET_TITLE = "HyperIDE.ai · AI Agents"

interface Args {
  imageDir: string
  dryRun: boolean
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  let imageDir = ""
  let dryRun = false

  let i = 0
  while (i < args.length) {
    if (args[i] === "--image-dir") {
      imageDir = args[i + 1] ?? ""
      i += 2
    } else if (args[i] === "--dry-run") {
      dryRun = true
      i++
    } else {
      i++
    }
  }

  if (!imageDir) {
    console.error("Usage: bun scripts/create-ai-emoji-set.ts --image-dir ./assets [--dry-run]")
    process.exit(1)
  }

  return { imageDir, dryRun }
}

async function getBotUsername(token: string): Promise<string> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`)
  const data = await resp.json() as { ok: boolean; result?: { username: string }; description?: string }
  if (!data.ok) throw new Error(`getMe failed: ${data.description ?? "unknown"}`)
  return data.result!.username
}

async function createSet(token: string, ownerId: number, imageDir: string, dryRun: boolean): Promise<void> {
  const botUsername = await getBotUsername(token)
  const setName = `${SET_NAME}_by_${botUsername}`

  const entries = Object.entries(AI_MODELS)

  // Preflight: every configured model MUST have an image. A partial upload
  // would create a broken set that still looks successful, so fail first.
  const missing = entries
    .map(([model]) => model)
    .filter((model) => !existsSync(join(imageDir, `${model}.png`)))

  if (dryRun) {
    console.log(`[DRY RUN] Would create set: ${setName}`)
    for (const [model, emoji] of entries) {
      const p = join(imageDir, `${model}.png`)
      const status = existsSync(p) ? "" : " (MISSING)"
      console.log(`  - ${model}: ${emoji} (${p})${status}`)
    }
    if (missing.length) {
      console.log(`[DRY RUN] ${missing.length} image(s) missing: ${missing.join(", ")}`)
    }
    return
  }

  if (missing.length) {
    console.error(`Error: missing image(s) for: ${missing.join(", ")}`)
    console.error(`Generate them first: build-emoji-icons.py --prefix '' --out ${imageDir}`)
    process.exit(1)
  }

  // Bot API 6.6+ createNewStickerSet: pass `stickers` as a JSON array of
  // InputSticker objects, each referencing an attached file via attach://.
  // Up to 50 stickers per call, so create the whole set in one request.
  const form = new FormData()
  form.append("user_id", String(ownerId))
  form.append("name", setName)
  form.append("title", SET_TITLE)
  form.append("sticker_type", "custom_emoji")
  const inputStickers = entries.map(([model, emoji], idx) => {
    const attach = `file${idx}`
    form.append(attach, Bun.file(join(imageDir, `${model}.png`)))
    return { sticker: `attach://${attach}`, format: "static", emoji_list: [emoji] }
  })
  form.append("stickers", JSON.stringify(inputStickers))

  const resp = await fetch(`https://api.telegram.org/bot${token}/createNewStickerSet`, {
    method: "POST",
    body: form,
  })
  const result = await resp.json() as { ok: boolean; description?: string }
  if (!result.ok) {
    console.error(`Error creating set: ${result.description ?? "unknown"}`)
    process.exit(1)
  }

  console.log(`Created set: ${setName} (${entries.length} stickers)`)

  // Fetch the finished set and emit model -> custom_emoji_id mapping. Stickers
  // come back in insertion order (matches AI_MODELS); zip by index since emoji
  // is ambiguous (meta and ollama share 🦙).
  const infoResp = await fetch(
    `https://api.telegram.org/bot${token}/getStickerSet?name=${setName}`)
  const info = await infoResp.json() as {
    ok: boolean
    result?: { stickers: Array<{ custom_emoji_id?: string }> }
  }
  if (!info.ok || !info.result) {
    console.warn(`Warning: could not fetch set for IDs`)
    return
  }
  const mapping: Record<string, string> = {}
  console.log(`\nSet URL: https://t.me/addemoji/${setName}\n\nmodel -> custom_emoji_id:`)
  entries.forEach(([model], idx) => {
    const cid = info.result!.stickers[idx]?.custom_emoji_id ?? ""
    mapping[model] = cid
    console.log(`  ${model}: ${cid}`)
  })
  console.log(`\nJSON:\n${JSON.stringify(mapping, null, 2)}`)
}

async function main() {
  const { imageDir, dryRun } = parseArgs()
  const token = process.env.TG_BOT_TOKEN
  const ownerId = process.env.TG_OWNER_ID ? parseInt(process.env.TG_OWNER_ID, 10) : 0

  if (!token) {
    console.error("Error: Set TG_BOT_TOKEN env var")
    process.exit(1)
  }
  if (!ownerId) {
    console.error("Error: Set TG_OWNER_ID env var to your Telegram numeric user ID")
    process.exit(1)
  }

  await createSet(token, ownerId, imageDir, dryRun)
}

main()

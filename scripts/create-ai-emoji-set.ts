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
 *   ai_models_code_by_<bot_username>
 */

import { readFileSync } from "fs"
import { join } from "path"

const AI_MODELS: Record<string, string> = {
  claude: "🤖",
  codex: "👐",
  gemini: "♊️",
  deepseek: "🐳",
  qwen: "🟣",
  kimi: "🌙",
  glm: "🗂",
  gpt: "⚡",
  openai: "⚡",
}

const SET_NAME = "ai_models_code"
const SET_TITLE = "AI Models for Code"

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
  const [firstModel, firstEmoji] = entries[0]
  const firstPath = join(imageDir, `${firstModel}.png`)

  if (dryRun) {
    console.log(`[DRY RUN] Would create set: ${setName}`)
    for (const [model, emoji] of entries) {
      const p = join(imageDir, `${model}.png`)
      try {
        Bun.file(p)
        console.log(`  - ${model}: ${emoji} (${p})`)
      } catch {
        console.log(`  - ${model}: ${emoji} (MISSING: ${p})`)
      }
    }
    return
  }

  // Check first image exists
  try {
    Bun.file(firstPath)
  } catch {
    console.error(`Error: First image missing: ${firstPath}`)
    process.exit(1)
  }

  // Create set
  const form = new FormData()
  form.append("user_id", String(ownerId))
  form.append("name", setName)
  form.append("title", SET_TITLE)
  form.append("emojis", firstEmoji)
  form.append("sticker_type", "custom_emoji")
  form.append("sticker", Bun.file(firstPath))

  const resp = await fetch(`https://api.telegram.org/bot${token}/createNewStickerSet`, {
    method: "POST",
    body: form,
  })
  const result = await resp.json() as { ok: boolean; description?: string }
  if (!result.ok) {
    console.error(`Error creating set: ${result.description ?? "unknown"}`)
    process.exit(1)
  }

  console.log(`Created set: ${setName}`)

  // Add remaining stickers
  for (const [model, emoji] of entries.slice(1)) {
    const path = join(imageDir, `${model}.png`)
    try {
      Bun.file(path)
    } catch {
      console.log(`  Skipping ${model} (missing image)`)
      continue
    }

    const addForm = new FormData()
    addForm.append("user_id", String(ownerId))
    addForm.append("name", setName)
    addForm.append("emojis", emoji)
    addForm.append("sticker", Bun.file(path))

    const addResp = await fetch(`https://api.telegram.org/bot${token}/addStickerToSet`, {
      method: "POST",
      body: addForm,
    })
    const addResult = await addResp.json() as { ok: boolean; description?: string }
    if (addResult.ok) {
      console.log(`  Added ${model}: ${emoji}`)
    } else {
      console.log(`  Error adding ${model}: ${addResult.description ?? "unknown"}`)
    }
  }
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

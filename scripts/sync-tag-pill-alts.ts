#!/usr/bin/env bun
/**
 * Sync the Telegram-side per-cell ALTS (emoji_list) of the tag PILLS to the
 * code's per-cell dots: cell 0 = the tag's COLORED dot, cells 1..n-1 = the
 * neutral square (▫️).
 *
 * WHY: each tag pill is N custom-emoji CELLS. The cell IMAGE spells the wordmark
 * (premium clients see it). But a PUSH NOTIFICATION is rendered by the OS, which
 * can't load the custom-emoji image — it shows each cell's ALT (emoji_list[0])
 * instead. With every cell's alt the same color dot, a notification reads
 * "🔵🔵🔵 ANSWER" (three loud identical dots). Setting cells 1..n-1 to ▫️ makes it
 * read "🔵▫️▫️": ONE colored dot identifies the tag, the rest stay quiet.
 * (CTO 2026-06-15.)
 *
 * The pill IMAGE is UNCHANGED — only the per-cell fallback alt changes. The
 * renderer (features/render/prefix.ts) emits each <tg-emoji> cell wrapping the
 * SAME per-cell dot (tagPillCellDots), so the entity's inner fallback text
 * matches its sticker alt (Telegram drops the entity otherwise).
 *
 * Telegram API: setStickerEmojiList(sticker=<file_id>, emoji_list=[...]) mutates
 * a sticker's alt IN PLACE — the custom_emoji_id is unchanged, so TAG_PILL_IDS
 * stays valid. We resolve each cell's file_id from getStickerSet (custom_emoji_id
 * -> sticker.file_id), then set its alt.
 *
 * Credentials: same as create-tag-emoji.ts — TG_EMOJI_BOT_TOKEN (the set owner
 * @hyperidebot), falling back to TG_BOT_TOKEN. The token is NEVER printed.
 *
 * Run: bun scripts/sync-tag-pill-alts.ts [--dry-run]
 *   --dry-run prints the planned alts per cell without mutating anything.
 *
 * Idempotent: re-running sets the same alts. Always run getCustomEmojiStickers
 * after (this script verifies and prints the resulting alts per tag).
 */

import { resolveConfigEnv } from '../features/config/env';
import { TAG_PILL_IDS, tagPillCellDots } from '../features/branding/emoji';

const SET_NAME_PREFIX = 'replytags';

interface Sticker {
  file_id: string;
  custom_emoji_id?: string;
  emoji?: string;
}

async function getBotUsername(token: string): Promise<string> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = (await resp.json()) as { ok: boolean; result?: { username: string }; description?: string };
  if (!data.ok || !data.result) throw new Error(`getMe failed: ${data.description ?? 'unknown'}`);
  return data.result.username;
}

async function getSetStickers(token: string, setName: string): Promise<Sticker[]> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getStickerSet?name=${setName}`);
  const data = (await resp.json()) as { ok: boolean; result?: { stickers: Sticker[] }; description?: string };
  if (!data.ok || !data.result) throw new Error(`getStickerSet failed: ${data.description ?? 'unknown'}`);
  return data.result.stickers;
}

// Set ONE cell's alt. Returns an error string on failure instead of throwing,
// so a transient failure mid-sync does NOT abort the loop before verification:
// the caller keeps going (attempting the rest), then ALWAYS verifies the live
// set, so a partial sync is SURFACED (verify fails) rather than silently exited.
async function setAlt(token: string, fileId: string, emoji: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/setStickerEmojiList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sticker: fileId, emoji_list: [emoji] }),
    });
    const data = (await resp.json()) as { ok: boolean; description?: string };
    return data.ok ? null : (data.description ?? 'unknown');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function verifyAlts(token: string): Promise<boolean> {
  const allIds = Object.values(TAG_PILL_IDS).flat();
  const url = `https://api.telegram.org/bot${token}/getCustomEmojiStickers?custom_emoji_ids=${encodeURIComponent(
    JSON.stringify(allIds),
  )}`;
  const resp = await fetch(url);
  const data = (await resp.json()) as { ok: boolean; result?: Sticker[]; description?: string };
  if (!data.ok || !data.result) throw new Error(`getCustomEmojiStickers failed: ${data.description ?? 'unknown'}`);
  const byId = new Map(data.result.map((s) => [s.custom_emoji_id, s.emoji]));
  console.log('\nVerification (getCustomEmojiStickers):');
  // Compare the LIVE alts against the planned per-cell dots. Any drift is fatal:
  // the renderer's <tg-emoji> inner text MUST equal the live alt or Telegram
  // drops the entity, so an unsynced cell is a broken badge, not a warning.
  let allMatch = true;
  for (const [tag, ids] of Object.entries(TAG_PILL_IDS)) {
    const want = tagPillCellDots(tag);
    const got = ids.map((id) => byId.get(id) ?? '?');
    const ok = got.length === want.length && got.every((a, i) => a === want[i]);
    if (!ok) allMatch = false;
    console.log(`  ${tag.padEnd(9)} ${JSON.stringify(got)}${ok ? '' : ` != planned ${JSON.stringify(want)}`}`);
  }
  return allMatch;
}

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const env = resolveConfigEnv();
  const token = env.TG_EMOJI_BOT_TOKEN || env.TG_BOT_TOKEN;
  if (!token) {
    console.error('Error: set TG_EMOJI_BOT_TOKEN (or TG_BOT_TOKEN) in ~/.config/tg-cli/.env');
    process.exit(1);
  }

  const setName = `${SET_NAME_PREFIX}_by_${await getBotUsername(token)}`;
  const stickers = await getSetStickers(token, setName);
  // custom_emoji_id -> file_id (setStickerEmojiList wants the file id).
  const fileIdByEmojiId = new Map(
    stickers.filter((s) => s.custom_emoji_id).map((s) => [s.custom_emoji_id!, s.file_id]),
  );

  // PREFLIGHT: build the ENTIRE mutation plan first and fail BEFORE any setAlt
  // call if any cell's custom_emoji_id has no file_id. Mutating mid-discovery
  // would leave the remote set partially synced (earlier cells changed, later
  // ones not) — so resolve everything up front, then apply atomically-ish.
  interface PlannedAlt {
    tag: string;
    idx: number;
    fileId: string;
    alt: string;
  }
  const plan: PlannedAlt[] = [];
  const missing: string[] = [];
  for (const [tag, ids] of Object.entries(TAG_PILL_IDS)) {
    const cellDots = tagPillCellDots(tag);
    console.log(`${tag}: planned alts ${JSON.stringify(cellDots)}`);
    for (let i = 0; i < ids.length; i++) {
      const alt = cellDots[i];
      if (!alt) continue;
      const fileId = fileIdByEmojiId.get(ids[i]);
      if (!fileId) {
        missing.push(`${tag}[${i}] (${ids[i]})`);
        continue;
      }
      plan.push({ tag, idx: i, fileId, alt });
    }
  }
  if (missing.length) {
    // FATAL, before any mutation: a cell with no resolvable file_id can't be
    // synced; its live alt would stay wrong and Telegram would drop the rendered
    // <tg-emoji>. Never mutate a half-resolvable set.
    console.error(`\nERROR: no file_id in set ${setName} for: ${missing.join(', ')} — refusing to sync.`);
    process.exit(1);
  }

  if (dryRun) {
    for (const p of plan) console.log(`  [DRY] ${p.tag}[${p.idx}]: set alt -> ${p.alt}`);
    console.log('\n[DRY RUN] no changes made.');
    return;
  }

  // Attempt EVERY planned update (don't abort on the first failure), collecting
  // any failures. Then ALWAYS verify the live set — so a transient setAlt failure
  // mid-sync surfaces as reported failures + a verify mismatch, never a silent
  // half-synced exit.
  const failed: string[] = [];
  for (const p of plan) {
    const err = await setAlt(token, p.fileId, p.alt);
    if (err) {
      failed.push(`${p.tag}[${p.idx}] -> ${p.alt}: ${err}`);
      console.error(`  ${p.tag}[${p.idx}]: set alt -> ${p.alt}  FAILED: ${err}`);
    } else {
      console.log(`  ${p.tag}[${p.idx}]: set alt -> ${p.alt}`);
    }
  }

  // Verify the live set matches the planned alts. Any failed update or drift is
  // fatal — the renderer's <tg-emoji> inner text must equal the live alt.
  const verified = await verifyAlts(token);
  if (failed.length) {
    console.error(`\nERROR: ${failed.length} update(s) failed — set is partially synced:`);
    for (const f of failed) console.error(`  - ${f}`);
    console.error('Re-run to retry the failed cells.');
    process.exit(1);
  }
  if (!verified) {
    console.error('\nERROR: live alts do NOT match the planned per-cell dots — the set is out of sync.');
    process.exit(1);
  }
  console.log('\nOK: live alts match the planned per-cell dots.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

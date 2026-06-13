// Agent branding: the custom-emoji / unicode-emoji maps and model-name → base-key
// resolution (tg decomposition Stage 0, docs/specs/tg-decomposition.md). Pure data
// + a pure lookup; the `tg` entrypoint imports these instead of defining them
// inline. Behaviour is unchanged.
//
// WARNING: the structure of EMBEDDABLE_EMOJI_MAP is regex-parsed by
// tests/emoji_map.test.ts. If you change its formatting (nested braces, comments
// containing `}`, trailing commas), update that test in lockstep.
//
// Default: HyperIDE.ai custom emoji set (https://t.me/addemoji/agents_by_HyperIDE_Bot)
export const EMBEDDABLE_EMOJI_MAP: Record<string, string> = {
  hyperide: "5274191514178723918", // 🚁 HyperIDE
  codex: "5273797309195393626",   // 👐 OpenAI
  openai: "5273797309195393626",  // 👐 OpenAI
  claude: "5274170649227600531",  // ✳️ Claude
  anthropic: "5274170649227600531", // ✳️ Claude
  gemini: "5274254027427716477",  // ♊️ Gemini
  google: "5274254027427716477",  // ♊️ Gemini
  deepseek: "5274018976752511967", // 🐳 DeepSeek
  qwen: "5274109179655661197",    // 🟣 Qwen
  alibaba: "5274109179655661197", // 🟣 Qwen
  kimi: "5273889053991805596",    // 🌙 Kimi
  moonshot: "5273889053991805596", // 🌙 Kimi
  o3: "5273797309195393626",      // 👐 OpenAI
  o1: "5273797309195393626",      // 👐 OpenAI
  gpt4: "5273797309195393626",    // 👐 OpenAI
  gpt3: "5273797309195393626",    // 👐 OpenAI
  llama: "5274259902942977093",   // 🦙 Meta/llama
  meta: "5274259902942977093",    // 🦙 Meta
  ollama: "5273886056104634966",  // 🦙 Ollama
  mistral: "5273823740424134905", // Ⓜ️ Mistral
  grok: "5273973737861981852",    // 🤘 Grok
  xai: "5273973737861981852",     // 🤘 Grok
  copilot: "5274136375388580049", // 🦾 Copilot
  github: "5274136375388580049",   // 🦾 Copilot
  perplexity: "5273733846758631156", // 🔮 Perplexity
  cursor: "5273731871073672487",  // 👆 Cursor
  windsurf: "5273875761068025296", // 🏄 Windsurf
  devin: "5274170649227600531",   // Custom ID: shares Claude's ✳️ ID. Unicode: 🧑‍💻
  cognition: "5274170649227600531", // Custom ID: shares Claude's ✳️ ID. Unicode: 🧑‍💻
  aider: "5274170649227600531",    // Custom ID: shares Claude's ✳️ ID. Unicode: 🤝
  continue: "5274170649227600531", // Custom ID: shares Claude's ✳️ ID. Unicode: ⏩
  gpt: "5273797309195393626",       // Custom ID: shares OpenAI's 👐 ID. Unicode: ⚡
}

// Unicode emoji fallback map
export const UNICODE_EMOJI_MAP: Record<string, string> = {
  claude: "✳️", anthropic: "✳️",
  codex: "👐", openai: "👐", o3: "👐", o1: "👐", gpt4: "👐", gpt3: "👐", gpt: "⚡",
  gemini: "♊️", google: "♊️",
  deepseek: "🐳",
  qwen: "🟣", alibaba: "🟣",
  kimi: "🌙", moonshot: "🌙",
  glm: "🗂", chatglm: "🗂",
  llama: "🦙", meta: "🦙", ollama: "🦙",
  mistral: "Ⓜ️",
  grok: "🤘", xai: "🤘",
  copilot: "🦾", github: "🦾",
  perplexity: "🔮",
  cursor: "👆",
  windsurf: "🏄",
  devin: "🧑‍💻", cognition: "🧑‍💻",
  aider: "🤝",
  continue: "⏩",
  hyperide: "🚁",
  fireworks: "🎆",
}

// AI emoji mapping (plum11 convention + extended)
export const MODEL_EMOJI_MAP: Record<string, string> = {
  claude: "✳️", anthropic: "✳️",
  codex: "👐", openai: "👐", o3: "👐", o1: "👐", gpt4: "👐", gpt3: "👐",
  gemini: "♊️", google: "♊️",
  deepseek: "🐳",
  qwen: "🟣", alibaba: "🟣",
  kimi: "🌙", moonshot: "🌙",
  glm: "🗂", chatglm: "🗂",
  llama: "🦙", meta: "🦙", ollama: "🦙",
  mistral: "Ⓜ️",
  grok: "🤘", xai: "🤘",
  copilot: "🦾", github: "🦾",
  perplexity: "🔮",
  cursor: "👆",
  windsurf: "🏄",
  devin: "🧑‍💻", cognition: "🧑‍💻",
  aider: "🤝",
  continue: "⏩",
  hyperide: "🚁",
  fireworks: "🎆",
  gpt: "⚡",
}

// A custom-emoji entity on the outbound text (Telegram messageEntityCustomEmoji):
// offset/length are UTF-16 positions into the rendered text.
export interface EmojiEntity {
  type: "custom_emoji"
  offset: number
  length: number
  custom_emoji_id: string
}

export interface ParsedText {
  text: string
  entities: EmojiEntity[]
}

// Resolve a model name to its emoji-map base key: exact match, then progressively
// shorter "-"/"_"-split prefixes (e.g. "claude-opus-4" → "claude"). Falls back to
// the lowercased name when nothing matches.
export function extractBaseModel(modelName: string): string {
  const lower = modelName.toLowerCase()
  if (MODEL_EMOJI_MAP[lower]) return lower
  if (EMBEDDABLE_EMOJI_MAP[lower]) return lower
  const parts = lower.split(/[-_]/)
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join("-")
    if (MODEL_EMOJI_MAP[prefix]) return prefix
    if (EMBEDDABLE_EMOJI_MAP[prefix]) return prefix
  }
  return lower
}

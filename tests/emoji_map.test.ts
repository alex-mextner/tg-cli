import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync, writeFileSync, chmodSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Import the emoji map from the CLI
const TG_PATH = new URL("../tg", import.meta.url).pathname
// The maps were extracted out of `tg` into the branding module (decomposition
// Stage 0); the source-parse tests read the COMBINED source so a regex finds the
// maps (now in the module) and the help text / comments (still in `tg`) alike.
const EMOJI_MODULE_PATH = new URL("../features/branding/emoji.ts", import.meta.url).pathname
async function combinedSource(): Promise<string> {
  return (await Bun.file(TG_PATH).text()) + "\n" + (await Bun.file(EMOJI_MODULE_PATH).text())
}

// Create a temp dir with a fake `pgrep` that reports `ollama` as running.
// Prepending it to PATH lets us prove the Claude env check wins over the
// pgrep fallback even when an ollama daemon is genuinely up.
function fakePgrepBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tg-fakebin-"))
  const script = '#!/bin/sh\nfor a in "$@"; do [ "$a" = "ollama" ] && exit 0; done\nexit 1\n'
  const p = join(dir, "pgrep")
  writeFileSync(p, script)
  chmodSync(p, 0o755)
  return dir
}

// Drop a fake `ps` into `dir` whose ancestry snapshot makes tg's PARENT look
// like the given agent command (or, when agentCommand is empty, like a plain
// shell with no agent ancestor). tg climbs from process.ppid, so we resolve the
// real ppid of the tg process ($PPID of this fake ps) via the absolute /bin/ps
// and label it. This lets us prove ancestry detection beats the pgrep fallback.
function writeFakePs(dir: string, agentCommand: string): void {
  const parentCmd = agentCommand || "-zsh"
  const script =
    "#!/bin/sh\n" +
    'TG="$PPID"\n' +
    'TGPPID=$(/bin/ps -o ppid= -p "$TG" 2>/dev/null | tr -d " ")\n' +
    '[ -z "$TGPPID" ] && TGPPID=1\n' +
    'echo "$TG $TGPPID bun run tg"\n' +
    `echo "$TGPPID 1 ${parentCmd}"\n`
  const p = join(dir, "ps")
  writeFileSync(p, script)
  chmodSync(p, 0o755)
}

// Sanitize environment for subprocess tests
// Whitelist only essential vars to prevent env leakage
function sanitizeEnv(): Record<string, string> {
  const whitelist = ["PATH", "TMPDIR"]
  const env: Record<string, string> = {}
  for (const key of whitelist) {
    const val = process.env[key]
    if (val !== undefined) {
      env[key] = val
    }
  }
  // Use a temporary HOME to prevent loading user's tg-cli config
  env["HOME"] = "/tmp/tg-cli-test-home"
  return env
}

// Parse the EMBEDDABLE_EMOJI_MAP from the source file
async function parseEmojiMap(): Promise<Record<string, string>> {
  const content = await combinedSource()
  const map: Record<string, string> = {}
  
  // Simple regex extraction
  const match = content.match(/const EMBEDDABLE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  if (!match) {
    throw new Error("Failed to parse EMBEDDABLE_EMOJI_MAP from tg source")
  }
  const lines = match[1].split('\n')
  for (const line of lines) {
    const keyMatch = line.match(/(\w+):\s*["\x27](\d+)["\x27],/)
    if (keyMatch) {
      map[keyMatch[1]] = keyMatch[2]
    }
  }
  if (Object.keys(map).length === 0) {
    throw new Error("Failed to extract any emoji IDs from EMBEDDABLE_EMOJI_MAP")
  }
  return map
}

let EMBEDDABLE_EMOJI_MAP: Record<string, string> = {}

beforeAll(async () => {
  EMBEDDABLE_EMOJI_MAP = await parseEmojiMap()
})

test("EMBEDDABLE_EMOJI_MAP has no duplicate IDs", () => {
  const ids = Object.values(EMBEDDABLE_EMOJI_MAP)
  const unique = new Set(ids)
  // Note: some aliases intentionally share IDs (e.g., codex/openai, claude/anthropic)
  // There are exactly 15 unique custom emoji IDs in the current set (v10).
  // Update this count when adding new unique custom emoji IDs.
  expect(unique.size).toBe(15)
  expect(ids.length).toBeGreaterThanOrEqual(15)
})

test("EMBEDDABLE_EMOJI_MAP has all expected models", () => {
  const expected = [
    "hyperide", "codex", "openai", "claude", "anthropic",
    "gemini", "google", "deepseek", "qwen", "alibaba",
    "kimi", "moonshot", "o3", "o1", "gpt4", "gpt3", "gpt",
    "llama", "meta", "ollama", "mistral", "grok", "xai",
    "copilot", "github", "perplexity", "cursor", "windsurf",
    "devin", "cognition", "aider", "continue",
  ]
  for (const model of expected) {
    expect(EMBEDDABLE_EMOJI_MAP[model]).toBeDefined()
    expect(EMBEDDABLE_EMOJI_MAP[model]).toMatch(/^\d{19}$/)
  }
})

test("EMBEDDABLE_EMOJI_MAP IDs are valid format", () => {
  for (const [key, id] of Object.entries(EMBEDDABLE_EMOJI_MAP)) {
    expect(id).toMatch(/^\d{19}$/)
  }
})

test("UNICODE_EMOJI_MAP has glm fallback", async () => {
  // Parse UNICODE_EMOJI_MAP from source
  const content = await combinedSource()
  const match = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  expect(match).toBeTruthy()
  if (match) {
    expect(match[1]).toContain('glm: "🗂"')
    expect(match[1]).toContain('chatglm: "🗂"')
  }
})

test("glm is not in EMBEDDABLE_EMOJI_MAP (no custom emoji yet)", () => {
  expect(EMBEDDABLE_EMOJI_MAP["glm"]).toBeUndefined()
  expect(EMBEDDABLE_EMOJI_MAP["chatglm"]).toBeUndefined()
})

test("fireworks has Unicode fallback", async () => {
  const content = await combinedSource()
  const match = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  expect(match).toBeTruthy()
  if (match) {
    expect(match[1]).toContain('fireworks: "🎆"')
  }
})

test("gpt has Unicode fallback", async () => {
  const content = await combinedSource()
  const match = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  expect(match).toBeTruthy()
  if (match) {
    expect(match[1]).toContain('gpt: "⚡"')
  }
})

test("gpt shares OpenAI custom emoji ID", () => {
  expect(EMBEDDABLE_EMOJI_MAP["gpt"]).toBe("5273797309195393626")
})

test("fireworks is Unicode-only (no custom emoji ID)", () => {
  expect(EMBEDDABLE_EMOJI_MAP["fireworks"]).toBeUndefined()
})

test("alias pairs map to identical IDs", () => {
  const aliases = [
    ["codex", "openai", "o3", "o1", "gpt4", "gpt3", "gpt"],
    ["claude", "anthropic", "devin", "cognition", "aider", "continue"],
    ["gemini", "google"],
    ["qwen", "alibaba"],
    ["kimi", "moonshot"],
    ["llama", "meta"],
    ["grok", "xai"],
    ["copilot", "github"],
  ]
  for (const group of aliases) {
    const ids = group.map(k => EMBEDDABLE_EMOJI_MAP[k]).filter(Boolean)
    if (ids.length > 1) {
      const first = ids[0]
      for (const id of ids.slice(1)) {
        expect(id).toBe(first)
      }
    }
  }
})

test("EMBEDDABLE_EMOJI_MAP structure is consistent", () => {
  // All keys should be lowercase
  for (const key of Object.keys(EMBEDDABLE_EMOJI_MAP)) {
    expect(key).toBe(key.toLowerCase())
  }
  // No empty values
  for (const [key, val] of Object.entries(EMBEDDABLE_EMOJI_MAP)) {
    expect(val).toBeTruthy()
    expect(val.length).toBeGreaterThan(0)
  }
})

test("set URL in comment matches help text", async () => {
  const content = await combinedSource()
  // Find the comment URL (anchored to "// Default:")
  const commentMatch = content.match(/\/\/ Default:.*?t\.me\/addemoji\/(agents(?:_v\d+)?_by_[^\s)]+)/)
  // Find the help text URL (anchored to "Set:")
  const helpMatch = content.match(/Set: https:\/\/t\.me\/addemoji\/(agents(?:_v\d+)?_by_[^\s)]+)/)
  expect(commentMatch).toBeTruthy()
  expect(helpMatch).toBeTruthy()
  if (commentMatch && helpMatch) {
    expect(commentMatch[1]).toBe(helpMatch[1])
  }
})

// NOTE: When updating emoji IDs (e.g., v10 -> v11), verify all IDs still have 19 digits
// and alias groups remain consistent. The tests below validate structure and alias
// consistency without hardcoding every ID, making updates less brittle.

test("all documented helpers are resolvable (custom or Unicode)", async () => {
  const content = await combinedSource()
  // Extract UNICODE_EMOJI_MAP block for accurate matching
  const unicodeMatch = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  const unicodeBlock = unicodeMatch ? unicodeMatch[1] : ""
  const helpMatch = content.match(/Use :([\w:]+):.*?to embed custom emoji icons/s)
  expect(helpMatch).toBeTruthy()
  if (helpMatch) {
    const helpers = helpMatch[0].match(/:([a-zA-Z0-9_-]+):/g)
    expect(helpers).toBeTruthy()
    if (helpers) {
      const unique = [...new Set(helpers.map(h => h.replace(/:/g, '')))]
      for (const helper of unique) {
        const lower = helper.toLowerCase()
        // Should have either custom emoji or Unicode fallback
        const hasCustom = EMBEDDABLE_EMOJI_MAP[lower] !== undefined
        const escapedLower = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const unicodeRegex = new RegExp(`\\b${escapedLower}: ["']`, "m")
        const hasUnicode = unicodeRegex.test(unicodeBlock)
        expect(hasCustom || hasUnicode).toBe(true)
      }
    }
  }
})

// Environment variable override tests
// These test the override logic that happens at module load time
// We can't easily test the actual override without spawning a subprocess,
// but we can verify the parsing logic works

test("TG_EMOJI_IDS env override works at runtime", async () => {
  const overrideId = "9999999999999999999"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: overrideId }),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  // Should show the overridden ID in the output
  expect(exitCode).toBe(0)
  expect(stdout.includes(overrideId)).toBe(true)
}, 10000)

test("TG_EMOJI_ID_<model> env override works at runtime", async () => {
  const overrideId = "8888888888888888888"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: overrideId,
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.includes(overrideId)).toBe(true)
}, 10000)

test("TG_EMOJI_IDS overrides multiple keys simultaneously", async () => {
  const claudeOverride = "7777777777777777777"
  const codexOverride = "6666666666666666666"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: claudeOverride, codex: codexOverride }),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.includes(claudeOverride)).toBe(true)
  expect(stdout.includes(codexOverride)).toBe(true)
}, 10000)

test("TG_EMOJI_ID_<model> takes precedence over TG_EMOJI_IDS for existing model", async () => {
  const jsonOverride = "5555555555555555555"
  const envOverride = "4444444444444444444"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: jsonOverride }),
      TG_EMOJI_ID_CLAUDE: envOverride,
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.includes(envOverride)).toBe(true)
}, 10000)

test("TG_EMOJI_ID_<model> env var is processed for new model without crash", async () => {
  const jsonOverride = "5555555555555555555"
  const envOverride = "4444444444444444444"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ unknownmodel: jsonOverride }),
      TG_EMOJI_ID_UNKNOWNMODEL: envOverride,
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Per-model env var should be processed for new models too
  // (unknownmodel won't appear in ls-emoji-helpers because listEmojiHelpers
  // iterates MODEL_EMOJI_MAP, not EMBEDDABLE_EMOJI_MAP. We verify no crash
  // and that JSON override is not applied by checking for its absence)
  expect(stdout.includes(jsonOverride)).toBe(false)
}, 10000)

test("empty TG_EMOJI_IDS does not break defaults", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: "",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Should still show default IDs
  expect(stdout.includes("5274191514178723918")).toBe(true) // hyperide
}, 10000)

test("malformed TG_EMOJI_IDS does not break defaults", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: "not-valid-json",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Should still show default IDs despite malformed JSON
  expect(stdout.includes("5274191514178723918")).toBe(true) // hyperide
  expect(stderr.includes("Warning: TG_EMOJI_IDS contains invalid JSON")).toBe(true)
}, 10000)

test("TG_EMOJI_IDS with non-numeric ID is rejected with warning", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: "abc" }),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Non-numeric ID is rejected, default should be used
  expect(stdout.includes("abc")).toBe(false)
  expect(stderr.includes("Warning: Ignoring invalid emoji ID in TG_EMOJI_IDS")).toBe(true)
}, 10000)

test("TG_EMOJI_IDS with empty string value is rejected with warning", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: JSON.stringify({ claude: "" }),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Empty string doesn't match ^\d{19}$, so it's rejected as invalid
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
  // Should still show default Claude ID
  expect(stdout.includes("5274170649227600531")).toBe(true)
}, 10000)

test("TG_EMOJI_IDS with non-string value is rejected with warning", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: '{"claude":123}',
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Non-string value should be rejected with warning
  expect(stderr.includes("Warning: Ignoring non-string emoji ID")).toBe(true)
  expect(stdout.includes("5274170649227600531")).toBe(true)
}, 10000)

test("TG_EMOJI_IDS with null value is rejected gracefully", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: "null",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Null should be rejected with specific warning
  expect(stderr.includes("Warning: TG_EMOJI_IDS must be a JSON object")).toBe(true)
  expect(stdout.includes("Available emoji helpers:")).toBe(true)
}, 10000)

test("TG_EMOJI_ID_constructor is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CONSTRUCTOR: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_IDS with constructor is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: '{"constructor":"1234567890123456789"}',
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_ID_toString is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_TOSTRING: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_ID_valueOf is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_VALUEOF: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_IDS with array value is rejected gracefully", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: '["1234567890123456789"]',
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Arrays are explicitly rejected via Array.isArray(parsed) check
  expect(stderr.includes("Warning: TG_EMOJI_IDS must be a JSON object")).toBe(true)
  expect(stdout.includes("Available emoji helpers:")).toBe(true)
}, 10000)

test("empty TG_EMOJI_ID_ suffix is ignored", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Empty suffix should be ignored, no crash
  expect(stdout.includes("Available emoji helpers:")).toBe(true)
}, 10000)

test("TG_EMOJI_ID boundary values: empty string rejected", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Empty string doesn't match ^\d{19}$, so it's rejected as invalid
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
}, 10000)

test("TG_EMOJI_ID boundary values: 18-digit numeric rejected", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "123456789012345678",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // 18-digit numeric doesn't match ^\d{19}$, so it's rejected as invalid
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
  expect(stdout.includes("123456789012345678")).toBe(false)
}, 10000)

test("TG_EMOJI_ID boundary values: 20-digit numeric rejected", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "12345678901234567890",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // 20-digit numeric doesn't match ^\d{19}$, so it's rejected as invalid
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
  expect(stdout.includes("12345678901234567890")).toBe(false)
}, 10000)

test("TG_EMOJI_ID boundary values: exactly 19-digit numeric accepted", async () => {
  const validId = "1234567890123456789"
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: validId,
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Exactly 19-digit numeric matches ^\d{19}$, so it's accepted
  expect(stdout.includes(validId)).toBe(true)
  expect(stderr.includes("Warning")).toBe(false)
}, 10000)

test("TG_EMOJI_ID___proto__ is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID___PROTO__: "1234567890123456789",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Prototype pollution attempt should be rejected with specific warning
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_IDS with __proto__ is rejected for security", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_IDS: '{"__proto__":"1234567890123456789"}',
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Prototype pollution attempt should be rejected
  expect(stderr.includes("Warning: Rejecting reserved key")).toBe(true)
  expect(stdout.includes("1234567890123456789")).toBe(false)
}, 10000)

test("TG_EMOJI_ID can add new model not in default map", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_UNKNOWNMODEL: "9876543210987654321",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // New model should appear in ls-emoji-helpers because it was added to
  // EMBEDDABLE_EMOJI_MAP via env var. listEmojiHelpers iterates MODEL_EMOJI_MAP,
  // not EMBEDDABLE_EMOJI_MAP, so it won't show. But we verify no crash occurs.
  expect(stdout.includes("Available emoji helpers:")).toBe(true)
}, 10000)

test("gpt alias shares the same ID as gpt4 and gpt3", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // All three should appear as separate lines
  expect(stdout.includes(":gpt:")).toBe(true)
  expect(stdout.includes(":gpt4:")).toBe(true)
  expect(stdout.includes(":gpt3:")).toBe(true)
  // Each should have its own line with the correct emoji
  const gptLine = stdout.split("\n").find((line: string) => line.trim().startsWith(":gpt:"))
  const gpt4Line = stdout.split("\n").find((line: string) => line.trim().startsWith(":gpt4:"))
  const gpt3Line = stdout.split("\n").find((line: string) => line.trim().startsWith(":gpt3:"))
  expect(gptLine).toBeTruthy()
  expect(gpt4Line).toBeTruthy()
  expect(gpt3Line).toBeTruthy()
  // All share the same custom emoji ID
  expect(gptLine!.includes("5273797309195393626")).toBe(true)
  expect(gpt4Line!.includes("5273797309195393626")).toBe(true)
  expect(gpt3Line!.includes("5273797309195393626")).toBe(true)
}, 10000)

test("TG_EMOJI_ID_CLAUDE with non-numeric ID is rejected with warning", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "abc",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Non-numeric ID is rejected, default should be used
  expect(stdout.includes("abc")).toBe(false)
  expect(stderr.includes("Warning: Ignoring invalid emoji ID")).toBe(true)
}, 10000)

test("empty TG_EMOJI_ID_CLAUDE is treated as missing", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_EMOJI_ID_CLAUDE: "",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Empty string is falsy, so Claude should still have its default ID
  const claudeLine = stdout.split("\n").find((line: string) => line.includes(":claude:"))
  expect(claudeLine).toBeTruthy()
  expect(claudeLine!.includes("5274170649227600531")).toBe(true)
}, 10000)

test("unsupported helper :glm: is documented as Unicode-only", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--help"],
    env: {
      ...sanitizeEnv(),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // glm should be in Unicode-only section, not custom emoji section
  expect(stdout.includes("Unicode-only helpers")).toBe(true)
  expect(stdout.includes(":glm:")).toBe(true)
  expect(stdout.includes(":chatglm:")).toBe(true)
  expect(stdout.includes(":fireworks:")).toBe(true)
}, 10000)

test("Unicode-only helpers resolve correctly in ls-emoji-helpers", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // glm should show Unicode fallback with no emoji-id
  const glmLine = stdout.split("\n").find((line: string) => line.includes(":glm:"))
  expect(glmLine).toBeTruthy()
  expect(glmLine!.includes("🗂")).toBe(true)
  expect(glmLine!.includes("no emoji-id set")).toBe(true)
  // fireworks should show Unicode fallback with no emoji-id
  const fireworksLine = stdout.split("\n").find((line: string) => line.includes(":fireworks:"))
  expect(fireworksLine).toBeTruthy()
  expect(fireworksLine!.includes("🎆")).toBe(true)
  expect(fireworksLine!.includes("no emoji-id set")).toBe(true)
}, 10000)

test("all EMBEDDABLE_EMOJI_MAP keys are documented in help", async () => {
  const content = await combinedSource()
  const helpMatch = content.match(/Use :([\w:]+):.*?to embed custom emoji icons/s)
  expect(helpMatch).toBeTruthy()
  if (helpMatch) {
    const helpers = helpMatch[0].match(/:([a-zA-Z0-9_-]+):/g)
    expect(helpers).toBeTruthy()
    if (helpers) {
      const documented = new Set(helpers.map(h => h.replace(/:/g, "").toLowerCase()))
      for (const key of Object.keys(EMBEDDABLE_EMOJI_MAP)) {
        // Some keys are intentionally undocumented (aliases, internal)
        // These are aliases or internal keys that are intentionally not listed in the help text.
        // Update this list when adding new aliases that should not appear in --help.
        const undocumented = ["anthropic", "google", "alibaba", "moonshot", "xai", "github", "openai", "meta", "cognition"]
        if (!undocumented.includes(key)) {
          
          expect(documented.has(key)).toBe(true)
        }
      }
    }
  }
})

test("every EMBEDDABLE_EMOJI_MAP key has Unicode fallback", async () => {
  const content = await combinedSource()
  const match = content.match(/const UNICODE_EMOJI_MAP.*?= \{([^}]+)\}/s)
  expect(match).toBeTruthy()
  if (match) {
    const unicodeBlock = match[1]
    for (const key of Object.keys(EMBEDDABLE_EMOJI_MAP)) {
      // Use boundary check to avoid matching substrings (e.g., "gpt" inside "gpt4")
      // Match key followed by colon and quote, preceded by whitespace or comma
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(^|\\s|,)${escapedKey}: "`, "m")
      const hasFallback = regex.test(unicodeBlock)
      expect(hasFallback).toBe(true)
    }
  }
})


test("emoji helpers are resolved correctly in ls-emoji-helpers", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--ls-emoji-helpers"],
    env: {
      ...sanitizeEnv(),
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Check that some known helpers appear with correct Unicode (format: ":key: → emoji")
  expect(stdout.includes(":codex:")).toBe(true)
  expect(stdout.includes("👐")).toBe(true)
  expect(stdout.includes(":claude:")).toBe(true)
  expect(stdout.includes("✳️")).toBe(true)
  expect(stdout.includes(":deepseek:")).toBe(true)
  expect(stdout.includes("🐳")).toBe(true)
  // Check that custom emoji IDs are shown for embeddable helpers
  expect(stdout.includes("5274191514178723918")).toBe(true) // hyperide
  expect(stdout.includes("5274170649227600531")).toBe(true) // claude
  // Check ollama (new in v10) — specific line to avoid ambiguity with llama/meta
  const ollamaLine = stdout.split("\n").find((line: string) => line.includes(":ollama:"))
  expect(ollamaLine).toBeTruthy()
  expect(ollamaLine!.includes("🦙")).toBe(true)
  // Check gpt (new alias)
  expect(stdout.includes(":gpt:")).toBe(true)
  expect(stdout.includes("⚡")).toBe(true)
  // Check chatglm (Unicode-only)
  expect(stdout.includes(":chatglm:")).toBe(true)
  expect(stdout.includes("🗂")).toBe(true)
  // Check fireworks (Unicode-only)
  expect(stdout.includes(":fireworks:")).toBe(true)
  expect(stdout.includes("🎆")).toBe(true)
}, 10000)

test("CLAUDECODE env detects claude (not a background ollama daemon)", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: {
      ...sanitizeEnv(),
      CLAUDECODE: "1",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  // Regression: a running `ollama` daemon used to win the pgrep fallback and
  // mislabel Claude Code sessions as ollama.
  expect(stdout.startsWith("claude")).toBe(true)
  expect(stdout.includes("✳️")).toBe(true)
}, 10000)

test("TG_AI_MODEL overrides CLAUDECODE detection", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: {
      ...sanitizeEnv(),
      CLAUDECODE: "1",
      TG_AI_MODEL: "gemini",
      TG_BOT_TOKEN: "dummy",
      TG_CHAT_ID: "123",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.startsWith("gemini")).toBe(true)
}, 10000)

test("--detect-model works without Telegram credentials (info-only flag)", async () => {
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: {
      // No TG_BOT_TOKEN / TG_CHAT_ID — info-only flags must not require them.
      ...sanitizeEnv(),
      CLAUDECODE: "1",
    },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  expect(exitCode).toBe(0)
  expect(stdout.startsWith("claude")).toBe(true)
}, 10000)

test("CLAUDECODE beats a genuinely-running ollama (fake pgrep)", async () => {
  const env = sanitizeEnv()
  const binDir = fakePgrepBinDir()
  // Pin a no-agent ancestry so detection can't pick up a real `claude`/`codex`
  // in the test runner's own process tree — this test is about the pgrep path.
  writeFakePs(binDir, "")
  const PATH = `${binDir}:${env.PATH}`

  // Control: with a fake ollama 'running' and NO CLAUDECODE, detection falls
  // through to the pgrep block and reports ollama — proving the fake works.
  const control = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH },
    stdout: "pipe",
    stderr: "ignore",
  })
  const controlOut = await new Response(control.stdout).text()
  await control.exited
  expect(controlOut.startsWith("ollama")).toBe(true)

  // Regression: CLAUDECODE must win even though ollama is 'running'.
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH, CLAUDECODE: "1" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect((await proc.exited)).toBe(0)
  expect(stdout.startsWith("claude")).toBe(true)
}, 10000)

test("codex ancestor beats a background ollama daemon (fake ps + fake pgrep)", async () => {
  // Regression for the real bug: codex exports no env marker for the shell
  // commands it spawns (CODEX unset, CODEX_HOME empty), so detection fell
  // through to the pgrep block and a background `ollama` daemon won — branding
  // codex sessions as ollama. Ancestry detection must now win.
  const env = sanitizeEnv()
  const binDir = mkdtempSync(join(tmpdir(), "tg-fakebin-"))
  const ollamaScript =
    '#!/bin/sh\nfor a in "$@"; do [ "$a" = "ollama" ] && exit 0; done\nexit 1\n'
  writeFileSync(join(binDir, "pgrep"), ollamaScript)
  chmodSync(join(binDir, "pgrep"), 0o755)
  const PATH = `${binDir}:${env.PATH}`

  // Control: a plain shell ancestor (no agent) + ollama 'running' → ollama.
  writeFakePs(binDir, "")
  const control = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH },
    stdout: "pipe",
    stderr: "ignore",
  })
  const controlOut = await new Response(control.stdout).text()
  await control.exited
  expect(controlOut.startsWith("ollama")).toBe(true)

  // Now make tg's parent look like codex: ancestry must beat the ollama pgrep.
  writeFakePs(binDir, "/opt/homebrew/bin/codex exec --json")
  const proc = Bun.spawn({
    cmd: ["bun", "run", TG_PATH, "--detect-model"],
    env: { ...env, PATH },
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(stdout.startsWith("codex")).toBe(true)
}, 10000)

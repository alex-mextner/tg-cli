# tg-cli

Simple Telegram CLI to send messages, photos, and files via a bot.

## Installation

1. Clone the repo:
   ```bash
   git clone git@github.com:alex-mextner/tg-cli.git
   cd tg-cli
   ```

2. Create config:
   ```bash
   mkdir -p ~/.config/tg-cli
   cp .env.example ~/.config/tg-cli/.env
   # edit ~/.config/tg-cli/.env with your bot token and chat ID
   ```

3. Add to PATH (symlink or copy):
   ```bash
   ln -sf "$(pwd)/tg" ~/.local/bin/tg
   ```

## Requirements

- [Bun](https://bun.sh) — `#!/usr/bin/env bun`

## Config

Place your credentials in `~/.config/tg-cli/.env`:

```
TG_BOT_TOKEN=<your bot token from @BotFather>
TG_CHAT_ID=<your chat or user ID>
```

## Usage

```bash
# Send a text message
tg "Hello from the terminal"

# Send formatted HTML (auto-detected if tags present)
tg --format html "<b>Status</b>\nDone"
tg "<b>Auto-detected</b> HTML tags"  # same as --format html

# Send with custom emoji helpers
# (AI model auto-detected from running process)
tg "Hello :kimi: from the terminal"

# Send a photo
tg --photo screenshot.png

# Send a photo with caption
tg --photo screenshot.png "Look at this"

# Send a photo with HTML caption and custom emoji
tg --format html --photo diagram.png "<b>Report</b> :hyperide:"

# Send a file
tg --file report.pdf

# Send a file with caption
tg --file report.pdf "Monthly report"

# Send multiple photos with caption
tg --photo a.png --photo b.png "Two screenshots"

# Send multiple files
tg --file a.pdf --file b.pdf

# Mix photos and files
tg --photo diagram.png --file data.csv "Diagram and data"

# List all emoji helpers
tg --ls-emoji-helpers
```

Message text and captions decode `\n`, `\r`, `\t`, and `\\` into real newlines, carriage
returns, tabs, and backslashes. File paths are not decoded.

## Custom Emoji System

The CLI supports custom emoji icons for AI model identification. When running inside tmux, it auto-detects the current AI model (opencode, codex, aider, etc.) and prefixes messages with the corresponding custom emoji.

### Auto-detected models

- **Kimi** (🌙) — Moonshot AI
- **Claude** (✳️) — Anthropic
- **Codex** (👐) — OpenAI
- **Gemini** (♊️) — Google
- **DeepSeek** (🐳)
- **Qwen** (🟣) — Alibaba
- **Mistral** (Ⓜ️)
- **Grok** (🤘) — xAI
- **Copilot** (🦾) — GitHub
- **Perplexity** (🔮)
- **Cursor** (👆)
- **Windsurf** (🏄)
- **Ollama** (🦙)
- **HyperIDE** (🚁)

### Emoji helpers

Use `:model:` syntax in any message:

```bash
tg "Testing :codex: and :gemini: side by side"
tg --format html "<b>Models:</b> :claude: :deepseek: :qwen:"
```

### HTML + custom emoji together

When using `--format html`, custom emoji are converted to `<tg-emoji>` tags so both work simultaneously:

```bash
tg --format html "<b>Report</b> :kimi: \n<i>Status: complete</i>"
```

### Environment overrides

```bash
# Override single model
TG_EMOJI_ID_kimi=1234567890123456789 tg "message"

# Override multiple models
TG_EMOJI_IDS='{"kimi":"123","claude":"456"}' tg "message"

# Force AI model detection
TG_AI_MODEL=kimi tg "message"
```

See [docs/custom-emoji-system.md](docs/custom-emoji-system.md) for full specification.

## HTML Auto-detection

If `--format` is omitted but the text contains HTML tags (`<b>`, `<i>`, `<code>`, etc.), `parse_mode=HTML` is automatically enabled. This means you can write:

```bash
tg "<b>Important</b>: deployment complete"
```

Instead of:

```bash
tg --format html "<b>Important</b>: deployment complete"
```

## Screenshots

<table align="center" width="100%">
  <tr>
    <td align="center" width="33%">
      <img src="screenshots/report-1.png" width="300" alt="Status report with HTML formatting" />
      <br/>
      <sub><b>Status report</b> — HTML + custom emoji</sub>
    </td>
    <td align="center" width="33%">
      <img src="screenshots/report-2.png" width="300" alt="Visual evidence with multiple photos" />
      <br/>
      <sub><b>Visual evidence</b> — 3 photos + caption</sub>
    </td>
    <td align="center" width="33%">
      <img src="screenshots/report-3.png" width="300" alt="Summary with formatted list" />
      <br/>
      <sub><b>Summary</b> — structured findings</sub>
    </td>
  </tr>
</table>

## License

MIT — Copyright Alex Ultra, 2026

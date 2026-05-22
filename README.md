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

# Send a photo
tg --photo screenshot.png

# Send a photo with caption
tg --photo screenshot.png "Look at this"

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
```

## License

MIT — Copyright Alex Ultra, 2026

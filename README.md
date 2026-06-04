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

# Auto-attach: a file path in the message text is sent as an attachment
tg "here is the screenshot /tmp/shot.png"   # → photo, path stripped from caption
tg ~/reports/q1.pdf "Q1 numbers"            # → document with caption

# Print the version
tg --version
tg -v

# Print help (also shown for a bare `tg` with no arguments)
tg --help
tg -h
```

## Behavior notes

- **Unknown dashed tokens are plain text.** A token starting with `-`/`--` that
  is not a recognized flag (`--photo`, `--file`, `-v`/`--version`, `-h`/`--help`)
  is appended to the message text rather than treated as an error. So
  `tg "--foo is broken"` sends that literal text.
- **`-v` / `--version`** prints the version (`1.0.0`) and exits.
- **`-h` / `--help`** (anywhere in the args), or a bare `tg` with nothing to
  send, prints this usage to stdout and exits 0. Real API errors (missing token,
  failed send) still go to stderr with exit 1.
- **`OK` on success.** A successful send prints `OK` to stdout (the help/version
  paths do not). Failures go to stderr with exit 1.
- **Auto-attach by path.** Any token in the message text that resolves to an
  existing file is attached automatically — absolute paths, `~`-expanded home
  paths, or paths relative to the current directory. Image files (`png`, `jpg`,
  `jpeg`, `gif`, `webp`, `bmp`, `svg`, `heic`, `heif`, case-insensitive) are sent
  as photos; everything else as a document. The matched path token is removed
  from the caption, and explicit `--photo`/`--file` take precedence for the same
  file (it is never attached twice). Ordinary words and non-existent paths stay
  as text.

## Development

```bash
bun test   # runs tg.test.ts — pure arg-parsing tests, never touches Telegram
```

## License

MIT — Copyright Alex Ultra, 2026

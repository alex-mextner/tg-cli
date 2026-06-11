# tg — Telegram bridge for AI coding agents

The best way to monitor several coding agents at once: they push only what matters — status updates, blockers, a question — and you reply from your phone. Agent questions and permission prompts arrive as **tappable inline buttons**; no terminal round-trip needed.

Works with any agent in tmux: Claude Code, Codex, opencode, aider, and more.

## What it looks like

**An agent finishes a task:**
```bash
tg --format html "<b>HYP-576 done</b>\nAll tests pass. PR #42 opened."
# → Telegram message with ticket title inlined, PR linked, agent emoji prefix
```

**An agent asks a question — arrives as buttons:**
```
[Claude 🤖] Should I delete the old migration files?
  [Yes, delete]  [No, keep them]
```
Tap a button. The answer injects directly into the agent's tmux pane.

**An agent sends a generated artifact:**
```bash
tg --file report.md "Weekly summary"
# .md files are auto-converted to PDF before upload
```

---

## Install

**One-liner** (installs deps via bun, links `tg` into PATH, registers the agent skill):
```bash
curl -fsSL https://raw.githubusercontent.com/alex-mextner/tg-cli/main/install.sh | bash
```

**Register the skill manually** (idempotent; run automatically by the installer):
```bash
tg install-skill
```

`tg install-skill` makes agent harnesses aware of `tg`. It writes a skill file to
`~/.agents/skills/tg/` and, **for each detected harness**, appends a short always-on
blurb to its global instruction file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.config/opencode/AGENTS.md`, `~/.gemini/GEMINI.md`) and adds a Claude Code
`SessionStart` hook that surfaces installed agent CLIs at session start. All edits are
marked and idempotent — safe to re-run, and trivial to remove (delete the marked
blocks). Run automatically by the installer.

> Notes: the `SessionStart` hook prints the contents of `~/.agents/skills/.blurbs/*.md`
> into each session, so treat that directory as trusted (only the installers write there).
> `install-skill` is an exact-match subcommand — to send the literal text `install-skill`
> as a message, pipe it (`echo install-skill | tg -`) or add any other token.

**Manual clone:**
```bash
git clone git@github.com:alex-mextner/tg-cli.git
cd tg-cli
ln -sf "$(pwd)/tg" ~/.local/bin/tg
```

**Requirements:** [Bun](https://bun.sh)

**Config** — create `~/.config/tg-cli/.env`:
```
TG_BOT_TOKEN=<your bot token from @BotFather>
TG_CHAT_ID=<your chat or user ID>
```

---

## Outbound — agents push to Telegram

### Text and HTML reports

```bash
# Plain text (auto-detects agent, adds branded emoji prefix)
tg "Build finished, 0 errors"

# HTML — use Telegram's supported tag subset
tg --format html "<b>Status</b>\nAll checks green."

# HTML auto-detected when tags are present — --format html is optional
tg "<b>Important</b>: migration complete"
```

### Files, photos, and PDFs

```bash
tg --photo screenshot.png "Looks good"
tg --photo before.png --photo after.png "Comparison"
tg --file report.md "Weekly summary"    # .md auto-converted to PDF
tg --file data.csv --file chart.png "Results"
```

Markdown files (`*.md`, `*.markdown`) are silently converted to PDF via pandoc + headless Chrome before upload. On conversion failure the original file is sent instead — the send is never blocked. Requires `pandoc` and Chrome/Chromium 112+. Disable with `--no-feature md-as-pdf`.

### Auto-attach from message text

File paths mentioned in the message text are detected and attached automatically (images as photos, everything else as documents). The path token stays in the caption verbatim — it's only detected and attached, never removed. Recursive search across the worktree finds files by bare name or path suffix — `BFS`, shallowest match wins, `node_modules`/`.git`/`dist`-style dirs pruned.

### Secret-file denylist

Secret-looking files are **never** attached: `.env` family, SSH private keys, `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.ppk`, credential rc-files (`.netrc`, `.npmrc`, `.git-credentials`, …), shell histories, `*.tfvars`, `credentials.json`/`client_secret*.json`, `kubeconfig`. Auto-detected mentions are silently skipped; an explicit `--file prod.env` is a hard error. Override: `--no-feature attach-denylist`.

### Autolinks

**Linear tickets** (`HYP-576` style) — verified via the `linear` CLI, title inlined or appended. Requires `brew install schpet/tap/linear` + `linear auth login`. Disable: `--no-feature autolink-tasks`.

**GitHub PRs and issues** (`#42` style) — resolved against the cwd repo via `gh`. PRs get a state annotation (`(merged)`/`(open)`/`(draft)`). Disable: `--no-feature autolink-prs`.

Both features are ON by default. Both cache verdicts for 1 hour. Both degrade gracefully to plain text if the CLI is missing or not authenticated.

---

## Inbound — you reply from your phone

`tg-ctl` is the inbound daemon. It starts automatically on the first outbound `tg` send from a tmux pane with a detected agent. Stop it with `tg-ctl stop`.

### Sending a reply
Plain text from Telegram is injected into the agent's tmux pane as:
```
[TG from you] your message — reply via tg
```
The agent reads it and responds by calling `tg`.

### Q→buttons (v1.5.0)
Agent questions and permission prompts are forwarded to Telegram as inline buttons — no need to touch the terminal. Tap to answer; the answer is injected back into the pane immediately. Supports Claude Code question/permission shapes, Codex `PermissionRequest`, and opencode `question.asked`/`permission.asked` events.

### Commands
| Command | Effect |
|---------|--------|
| `/stop` | Inject Escape — interrupts the current agent turn, session survives |
| `/kill` | SIGINT the agent — session ends |
| `/status` | Report daemon state |

Photos and documents sent from Telegram are downloaded to `~/.cache/tg-cli/inbound/` and the local path is injected for the agent to read.

A successfully handled message gets a 👀 reaction as a delivery receipt.

### Opt out
```yaml
# ~/.config/tg-cli/config.yaml
control:
  enabled: false
```

> **One bot token per machine.** Telegram allows a single `getUpdates` consumer per token. Outbound `tg` is unaffected.

---

## Agent branding

`tg` auto-detects which agent is running by walking the tmux pane's process tree and prefixes every message with the agent's custom emoji icon. No configuration needed.

<img src="emoji-icons/mini_claude.png" width="16" height="16" align="top" alt="Claude" /> <b>Claude</b> — Anthropic<br/>
<img src="emoji-icons/mini_codex.png" width="16" height="16" align="top" alt="Codex" /> <b>Codex</b> — OpenAI<br/>
<img src="emoji-icons/mini_kimi.png" width="16" height="16" align="top" alt="Kimi" /> <b>Kimi</b> — Moonshot AI<br/>
<img src="emoji-icons/mini_gemini.png" width="16" height="16" align="top" alt="Gemini" /> <b>Gemini</b> — Google<br/>
<img src="emoji-icons/mini_deepseek.png" width="16" height="16" align="top" alt="DeepSeek" /> <b>DeepSeek</b><br/>
<img src="emoji-icons/mini_qwen.png" width="16" height="16" align="top" alt="Qwen" /> <b>Qwen</b> — Alibaba<br/>
<img src="emoji-icons/mini_mistral.png" width="16" height="16" align="top" alt="Mistral" /> <b>Mistral</b><br/>
<img src="emoji-icons/mini_grok.png" width="16" height="16" align="top" alt="Grok" /> <b>Grok</b> — xAI<br/>
<img src="emoji-icons/mini_copilot.png" width="16" height="16" align="top" alt="Copilot" /> <b>Copilot</b> — GitHub<br/>
<img src="emoji-icons/mini_perplexity.png" width="16" height="16" align="top" alt="Perplexity" /> <b>Perplexity</b><br/>
<img src="emoji-icons/mini_cursor.png" width="16" height="16" align="top" alt="Cursor" /> <b>Cursor</b><br/>
<img src="emoji-icons/mini_windsurf.png" width="16" height="16" align="top" alt="Windsurf" /> <b>Windsurf</b><br/>
<img src="emoji-icons/mini_ollama.png" width="16" height="16" align="top" alt="Ollama" /> <b>Ollama</b><br/>
<img src="emoji-icons/mini_hyperide.png" width="16" height="16" align="top" alt="HyperIDE" /> <b>HyperIDE</b><br/>

`opencode` is branded by the **model it runs** inside, falling back to a 📁 folder icon when the model can't be determined.

**v1.5.1 fix:** a background `ollama` daemon no longer mislabels a Codex session — env-var signals from the agent take priority over `pgrep` fallbacks.

Override if needed:
```bash
TG_AI_MODEL=kimi tg "message"
```

List all emoji helpers: `tg --ls-emoji-helpers`

Manual emoji in message text: `tg "done :codex: :gemini:"` — use any agent name as a `:name:` token.

See [docs/custom-emoji-system.md](docs/custom-emoji-system.md) for the full spec.

---

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

---

## How tg compares

Every other Telegram + AI-agent tool is a **remote terminal**: it mirrors the full session and you drive it from chat — the same shape as Claude Code's own first-party Remote Control (`/rc`). `tg` inverts that. The **agent curates** what is worth sending; it works for **any** agent in tmux (not just Claude); and inbound control is a thin, optional layer — not a full mirror.

### Philosophy

| Tool | Direction | Mental model | Agents |
|---|---|---|---|
| **tg** | Outbound-first, thin inbound | Curated agent reporting + poke-back | Any (multi-agent) |
| Anthropic Channels / Remote Control | Inbound-first | Remote terminal / chat bridge (first-party) | Claude only |
| Imolatte/tg-claude | Full-duplex | Remote terminal | Claude |
| oscarsterling/claude-telegram-remote | Full-duplex | Remote terminal (tmux) | Claude |
| RichardAtCT/claude-code-telegram | Full-duplex | Remote terminal (SDK) | Claude |
| JessyTsui/Claude-Code-Remote | Full-duplex | Remote terminal + trace delivery | Claude |
| jsayubi/ccgram | Full-duplex | Approvals + remote terminal | Claude |

### Features

| Tool | Curated out | Multi-agent brand | Media out | Inbound | Q→buttons | Full mirror |
|---|---|---|---|---|---|---|
| **tg** | ✓ | ✓ | ✓ | ✓ | ✓ | — (by design) |
| Anthropic Channels / RC | ~ (reply-only) | — | ✓ | ✓ | — | ✓ (RC) |
| Imolatte/tg-claude | — | — | ✓ | ✓ | ✓ | ✓ |
| oscarsterling | ~ (channel reply) | — | — | ✓ | ✓ | ~ |
| RichardAtCT | — | — | ✓ | ✓ | ~ | ✓ |
| JessyTsui | — (full trace) | — | — | ✓ | — | ✓ |
| ccgram | — | — | — | ✓ | ✓ | ✓ |

---

## Ecosystem

Part of the [HyperIDE.ai](https://hyperide.ai) agent toolchain:

- **[draw-cli](https://github.com/alex-mextner/draw-cli)** — text-to-image via Hugging Face
- **[review-cli](https://github.com/alex-mextner/review-cli)** — multi-model read-only code review
- **[3d-cli](https://github.com/alex-mextner/3d-cli)** — scriptable CLI for the full 3D FDM lifecycle: modeling, mesh repair, slicing, and print monitoring
- **[hyperide.ai](https://hyperide.ai)** — Figma replacement inside VS Code. Edit React components directly through AST/LSP without AI hallucinations, token waste, or context-window limits. Works for indie vibe-coding and for enterprise teams with split design/dev roles.

Each CLI registers a skill into your agent harnesses (`<tool> install-skill`) so agents know it exists — see Install.

---

## License

MIT

// install-skill: make agent harnesses aware that `tg` exists.
//
// Writes a SKILL.md (Agent Skills standard, ~/.agents/skills/) read by Claude
// Code, Codex, opencode, Gemini, Cursor; a short always-on blurb into each
// DETECTED harness's global instruction file; and an idempotent SessionStart
// hook that surfaces every installed agent-CLI at the top of each session.
//
// Mirror of the Python implementation in review-cli/draw-cli (same layout,
// markers, and hook command) so all three tools register identically.

import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { escapeRegExp } from '../util/regex';

// Read a UTF-8 file, returning undefined when it does not exist (ENOENT) and
// re-throwing any other error. Replaces an `existsSync(p) ? readFileSync(p) : …`
// pair: that check-then-read on the same path is a TOCTOU race (js/file-system-
// race) because the file can vanish or be swapped between the two syscalls. A
// single read that catches ENOENT is atomic — there is no window to race.
function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

// Prefer $HOME (what `tg` itself uses) over os.homedir(), which under Bun reads
// getpwuid and ignores $HOME — so this stays consistent and unit-testable.
function resolveHome(): string {
  return process.env.HOME || homedir();
}

const SKILL_NAME = 'tg';

const SKILL_MD = `---
name: tg
description: >-
  Send Telegram messages, files, photos, and formatted reports from any agent or
  shell. Use when the user asks to report results to Telegram, send a message or a
  file/photo, push a status / finding / question to their phone, or format an HTML
  report — e.g. \`tg "done"\`, \`tg --file out.pdf "caption"\`. Agents push status &
  questions; the user replies back; questions and permission prompts can become
  tappable inline buttons (tmux). The user can also reply by VOICE: a voice note
  is transcribed by a local Whisper (\`tg voice setup\`) and injected into the
  agent exactly like a typed reply. Always prefer this over direct curl to the
  Telegram API.
metadata:
  author: alex-mextner
  repo: https://github.com/alex-mextner/tg-cli
---

# tg — Telegram bridge for agents

Push reports and files to Telegram; the user can reply back (tmux).

## Invocation
\`\`\`
tg "text message"
tg --format html "<b>Title</b>\\nbody"
tg --format html "<h2>Heading</h2><table><tr><td>a</td><td>b</td></tr></table>"  # native rich table
tg --file report.pdf "caption"
tg --photo image.png "caption"
tg --reply-to 1234 --tag answer "answer that threads under message 1234"
printf 'task\\tstatus\\nship\\tdone' | tg --table   # plain monospace <pre> fallback
tg help format                                      # what formatting is supported
\`\`\`

## When to use
- Report a finished task / status / blocker / question to the user's phone.
- Send a generated artifact (file, photo, PDF) produced during a session.
- Long or multi-step work — push a full status update, not a one-liner.

## Header tag + title (\`--tag\` / \`--title\`)
The message header is \`✳️ [window]\`. The message BODY always stays BELOW it —
it is never pulled up onto the header line. Two optional flags put explicit
content on the header line:

- \`--title <text>\` — an explicit headline shown as \`✳️ [window] <title>\`.
  ONLY this explicit title ever appears there; the message body is never used.
- \`--tag <tag>\` — an emoji badge labeling what the message IS. Composes with
  \`--title\`: \`✳️ [window] 🔵 ANSWER — <title>\`.

Tags are LOWERCASE ENGLISH ONLY — \`answer\` / \`decision\` / \`problem\` / \`report\`.
The badge (the unicode fallback non-premium clients see) is a colored dot + the
English word:

| Tag | Badge | Use it for |
|-----|-------|------------|
| answer | 🔵 ANSWER | answering the user's question |
| decision | 🟠 DECISION | a decision you need the user to make / confirm |
| problem | 🔴 PROBLEM | a blocker / problem report |
| report | 🟢 REPORT | a status / result report |

Uppercase (\`ANSWER\`), Cyrillic (\`ОТВЕТ\`), and unknown tags are REJECTED with a
clear error and a non-zero exit — use a lowercase-english tag from the table.

In a PUSH NOTIFICATION (rendered by the OS, which can't load the pill image) the
badge shows as \`<color>▫️▫️\` — ONE colored dot identifies the tag
(🔵 answer / 🟠 decision / 🔴 problem / 🟢 report), the rest are neutral squares.
The tag word is not in the badge (any text after the dots is your \`--title\`/body).
In-app, premium clients still see the full wordmark pill.

## Subagent identification (\`--agent <label>\`) — REQUIRED when dispatching subagents
If you are an orchestrator dispatching subagents (Claude Code Task tool or equivalent),
and a subagent may call \`tg\` itself, ALWAYS pass \`--agent <descriptive-name>\` from that
subagent so the recipient can tell WHICH subagent sent a message, not just that some AI
did: \`tg --agent hyperide-fixer "done, PR #123 open"\` → \`✳️ [window] [hyperide-fixer] …\`.

Auto-detection exists ONLY for Claude Code, and ONLY as the generic label \`subagent\`
(env: \`CLAUDE_CODE_CHILD_SESSION\`) — it proves a message came from SOME subagent, never
which one (no per-agent id/description reaches the child process). Codex CLI and opencode
have no equivalent signal today. So: **don't rely on auto-detection** for anything beyond
"some subagent" — pass \`--agent\` explicitly whenever the identity matters. \`TG_AGENT\` env
is the same-precedence override as \`TG_AI_MODEL\` (flag wins, then env, then auto-detect).
Check what the current shell would auto-detect: \`tg --detect-agent\`.

(Not the same flag as \`tg-ctl\`'s own \`--agent <name>\` — that one selects a closed
harness kind for inbound telemetry, on a different binary.)

## Threaded replies (\`--reply-to <message_id>\`)
To answer a SPECIFIC inbound message and have your reply thread under it in
Telegram, pass its message_id: \`tg --reply-to <id> "answer"\` (sets
\`reply_to_message_id\`). The \`tg-ctl\` daemon surfaces the inbound id in the
injected wrap — \`[TG from Alex #1234] …\` — so the id to reply to is right there
in your pane. The id is Telegram's own per-chat message_id; nothing to compute.

The **answer** tag REQUIRES \`--reply-to\` (answering means answering a
specific message); without it \`tg\` errors with a clear message. The other tags
do not require it.

## Rich messages — tables, headings, lists, formulas (\`--format html\`, auto-routed)
\`--format html\` has TWO tiers, chosen AUTOMATICALLY by the tags in your body —
ONE flag, no \`--rich\`:
- **Basic** tags only (b/i/u/s/code/pre/a/blockquote/tg-emoji/tg-time/spoiler) →
  normal message (\`sendMessage\`).
- Any **rich** tag → a native Telegram **Rich Message** (\`sendRichMessage\`):
  real bordered tables (\`<table>\`/\`<tr>\`/\`<td>\`, \`align\`/\`colspan\`/\`<caption>\`),
  headings (\`<h1>\`..\`<h6>\`), lists (\`<ul>\`/\`<ol>\`/\`<li>\`), dividers (\`<hr>\`),
  collapsible \`<details>\`, and LaTeX formulas (\`<tg-math>\` inline / \`<tg-math-block>\`).
\`\`\`
tg --format html '<table bordered><tr><th>task</th><th>status</th></tr><tr><td>ship</td><td align="center">done</td></tr></table>'
tg --format html '<h2>Plan</h2><ul><li>step one</li><li>step two</li></ul><tg-math-block>E = mc^2</tg-math-block>'
\`\`\`
\`--tag\`/\`--title\`/\`--reply-to\` compose with rich. Rich limits: ≤ 32768 chars,
≤ 500 blocks, ≤ 16 nesting levels, ≤ 50 media, ≤ 20 table columns (\`tg\` errors
clearly if you exceed them).

## Plain table fallback (\`tg --table\`)
For a quick aligned grid WITHOUT authoring HTML, \`tg --table\` reads delimited rows
from STDIN (TSV, or \`a | b\` per line), auto-sizes columns, box-draws borders,
HTML-escapes cells, and sends a monospace \`<pre>\` block — the plain fallback. A
REAL bordered table comes from \`--format html\` with \`<table>\` (above). Composes
with \`--tag\`/\`--title\`; argv text becomes a heading above the table. Keep cells
ASCII/Cyrillic — double-width emoji/CJK push columns out of alignment.
\`\`\`
printf 'task\\tstatus\\nship\\tdone\\nreview\\twip' | tg --table
\`\`\`

## Formatting reference (\`tg help format\`)
\`tg help format\` prints the supported HTML tags and entities — the BASIC tier
plus the RICH tier (tables, headings, lists, formulas) auto-sent through the same
\`--format html\` — with a \`<table>\` example and the rich limits. Run it instead of
guessing at markup. (\`tg --format-help\` is a back-compat alias for the same.)

## Code/config files → mobile PDF (\`--with-original\` / \`--no-pdf\`)
Attaching a code/config file (\`.ts\`, \`.tsx\`, \`.json\`, \`.yaml\`, \`.toml\`, \`.py\`,
\`.go\`, \`.rs\`, \`.sql\`, \`Dockerfile\`, …) renders it to a MOBILE,
syntax-highlighted, soft-wrapped PDF — Telegram iOS previews the raw source
uselessly, so the PDF is what's actually readable on a phone.

- **Default: ONLY the PDF is sent.** The raw file is NOT attached (it's noise on
  iOS). This is the right default — just \`tg --file server.ts "look"\`.
- \`--with-original\` — also attach the raw file alongside the PDF.
- \`--no-pdf\` — skip the PDF, attach the raw file (the pre-feature behavior).
- \`--pdf-device <name>\` — page size: \`iphone15pro\` (default), \`iphone15promax\`,
  \`iphonese\`, \`a4\`. Also \`TG_PDF_DEVICE\` / \`TG_PDF_THEME\` (highlight style).

Markdown (\`.md\`) keeps its own \`.md\`→PDF path; non-code files are unchanged.
Requires pandoc + Google Chrome; on any failure the raw file is sent unchanged.

## Voice input (inbound STT — talk instead of type)
The user can answer the agent by sending a Telegram VOICE note instead of typing.
The \`tg-ctl\` daemon downloads the audio, transcodes it with \`ffmpeg\`, runs a
local Whisper (whisper.cpp or faster-whisper), and injects the transcript into
the agent's pane — routed exactly like a typed reply (a voice note sent as a
reply keeps the quote anchor and reaches the replied-to origin pane).

- \`tg voice setup\` — discover a local Whisper (\`~/xp\` first) + a model, check
  for \`ffmpeg\`, and persist the config. Run once.
- If a voice note arrives before voice is configured, the bot replies with a
  guided setup flow instead of dropping it.
- Config lives in the \`voice:\` block of \`~/.config/tg-cli/config.yaml\`
  (\`enabled\`, \`runner\`, \`bin_path\`, \`model_path\`, \`language\` — default
  \`auto\`, covering ru + en).
- Inbound media downloads (voice / photo / doc) retry with backoff on a
  transient network blip (3 attempts, jittered ~300ms→2.7s) before giving up,
  so a momentary hiccup no longer silently drops the message.

Always use \`tg\`, never direct curl to the Telegram API. tmux only.
`;

const SKILL_BLURB =
  '`tg` — send Telegram messages/files/reports: `tg "msg"`, ' +
  '`tg --format html "..."`, `tg --file f.pdf "cap"`, `tg --photo p.png`. ' +
  'Label messages with `--tag <answer|decision|problem|report>` ' +
  '(lowercase english only) and set an explicit header line with ' +
  '`--title "..."` (the body is never pulled up). ' +
  'Reply UNDER a specific inbound message with `--reply-to <message_id>` (the id ' +
  'shows up in the injected `[TG from … #<id>]` wrap); the answer tag ' +
  'requires it. ' +
  'If you are an ORCHESTRATOR dispatching subagents that may call `tg` themselves, ' +
  'ALWAYS pass `--agent <descriptive-name>` from each subagent so the recipient can ' +
  'tell WHICH subagent sent a message — auto-detection (Claude Code only) can only ' +
  'say "some subagent", never which one. ' +
  '`--format html` auto-sends a native Rich Message (tables, ' +
  'headings, lists, LaTeX formulas) when the body has a rich tag like `<table>`/' +
  '`<h1>`/`<ul>` — same flag, tg routes by content. `tg --table` is the plain ' +
  'monospace `<pre>` fallback grid. `tg help format` lists every supported ' +
  'HTML tag/entity (basic + rich tiers). ' +
  'Attaching a code/config file (.ts/.json/.yaml/.py/…) renders a mobile, ' +
  'syntax-highlighted PDF and by DEFAULT sends ONLY the PDF (raw file is useless ' +
  'on iOS); `--with-original` sends both, `--no-pdf` sends the raw file. ' +
  'The user can reply by VOICE — a voice note is transcribed by a local Whisper ' +
  '(`tg voice setup`) and injected like a typed reply. ' +
  'Use to report results/questions to the user. Never curl Telegram directly.';

const HOOK_MARKER = '# agent-tools-awareness';
const HOOK_COMMAND =
  `sh -c 'd="$HOME/.agents/skills/.blurbs"; ls "$d"/*.md >/dev/null 2>&1 && ` +
  `{ printf "Agent CLI tools installed on this machine (prefer them):\\n"; ` +
  `cat "$d"/*.md; }' ${HOOK_MARKER}`;

function detected(cmd: string, ...dirs: string[]): boolean {
  const probe = Bun.spawnSync(['sh', '-c', `command -v ${cmd}`], { stdout: 'ignore', stderr: 'ignore' });
  if (probe.exitCode === 0) return true;
  const home = resolveHome();
  return dirs.some((d) => existsSync(d.startsWith('~/') ? join(home, d.slice(2)) : d));
}

function appendMarked(path: string, tool: string, blurb: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const start = `<!-- skill:${tool} -->`;
  const end = `<!-- /skill:${tool} -->`;
  let existing = readTextIfExists(path) ?? '';
  const re = new RegExp(escapeRegExp(start) + '[\\s\\S]*?' + escapeRegExp(end) + '\\n?', 'g');
  existing = existing.replace(re, '');
  const block = `${start}\n${blurb}\n${end}\n`;
  writeFileSync(path, existing.trim() ? existing.replace(/\s+$/, '') + '\n\n' + block : block);
}

// Idempotently add a SessionStart hook to ~/.claude/settings.json that surfaces
// installed agent CLIs. Conservative: never removes or rewrites unrelated config.
function ensureSessionStartHook(home: string): boolean {
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(join(home, '.claude'))) return false;
  // Read the existing settings ONCE into memory, then parse from and back up
  // from that same in-memory copy. A separate existsSync()/readFileSync() per
  // use would re-stat the path each time, racing with concurrent writers
  // (js/file-system-race); a single read snapshots the bytes we then act on.
  const original = readTextIfExists(settingsPath);
  let data: any;
  try {
    data = original !== undefined ? JSON.parse(original) : {};
  } catch {
    return false; // don't clobber a file we can't parse
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  data.hooks ??= {};
  if (typeof data.hooks !== 'object' || data.hooks === null) return false;
  data.hooks.SessionStart ??= [];
  const sessionStart = data.hooks.SessionStart;
  if (!Array.isArray(sessionStart)) return false;
  for (const group of sessionStart) {
    const hooks = group && typeof group === 'object' ? group.hooks : null;
    if (Array.isArray(hooks)) {
      for (const h of hooks) {
        if (h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER)) return false;
      }
    }
  }
  sessionStart.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  // Back up the snapshot we already read (not a fresh read of the path) before
  // overwriting, so the .bak is exactly what we parsed and there is no second
  // check-then-read race.
  if (original !== undefined) writeFileSync(settingsPath + '.bak', original);
  writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n');
  return true;
}

export function installSkill(): number {
  const home = resolveHome();
  const written: string[] = [];

  // Layer 1 — SKILL.md (Agent Skills standard) + blurb file for the hook.
  const skillDir = join(home, '.agents', 'skills', SKILL_NAME);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD);
  written.push(join(skillDir, 'SKILL.md'));
  const blurbs = join(home, '.agents', 'skills', '.blurbs');
  mkdirSync(blurbs, { recursive: true });
  writeFileSync(join(blurbs, `${SKILL_NAME}.md`), `- ${SKILL_BLURB}\n`);

  // Claude Code also scans ~/.claude/skills — symlink for compatibility.
  const claudeSkills = join(home, '.claude', 'skills');
  if (existsSync(claudeSkills)) {
    const link = join(claudeSkills, SKILL_NAME);
    if (!existsSync(link)) {
      try {
        symlinkSync(join('..', '..', '.agents', 'skills', SKILL_NAME), link);
      } catch {
        // ignore — symlink unsupported or race
      }
    }
  }

  // Layer 2 — always-on blurb in each DETECTED harness's instruction file.
  const harnesses: [string, string, string[]][] = [
    ['claude', join(home, '.claude', 'CLAUDE.md'), ['~/.claude']],
    ['codex', join(home, '.codex', 'AGENTS.md'), ['~/.codex']],
    ['opencode', join(home, '.config', 'opencode', 'AGENTS.md'), ['~/.config/opencode']],
    ['gemini', join(home, '.gemini', 'GEMINI.md'), ['~/.gemini']],
  ];
  for (const [cmd, path, dirs] of harnesses) {
    if (detected(cmd, ...dirs)) {
      appendMarked(path, SKILL_NAME, SKILL_BLURB);
      written.push(path);
    }
  }

  // Layer 3 — SessionStart hook (Claude Code) aggregating all installed tools.
  if (existsSync(join(home, '.claude'))) {
    if (ensureSessionStartHook(home)) written.push('SessionStart hook -> ~/.claude/settings.json');
  }

  for (const w of written) console.log(`  ✓ ${w}`);
  console.log(`${SKILL_NAME}: install-skill done (${written.length} target(s)). Re-run anytime; idempotent.`);
  return 0;
}

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
  tappable inline buttons (tmux). Always prefer this over direct curl to the
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
tg --file report.pdf "caption"
tg --photo image.png "caption"
tg --tag ОТВЕТ --title "Short headline" "the full body below the header"
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
- \`--tag <TAG>\` — an emoji badge labeling what the message IS. Composes with
  \`--title\`: \`✳️ [window] 🔵 💬 ОТВЕТ — <title>\`.

Canonical tags (Russian; case-insensitive; English aliases map to them):

| Tag | Alias | Badge | Use it for |
|-----|-------|-------|------------|
| ОТВЕТ | ANSWER | 🔵 💬 | answering the user's question |
| РЕШЕНИЕ | DECISION | 🟠 ⚖️ | a decision you need the user to make / confirm |
| ПРОБЛЕМА | PROBLEM | 🔴 🚨 | a blocker / problem report |
| ОТЧЁТ | REPORT | 🟢 📋 | a status / result report |

An unknown tag is not fatal: it soft-renders as a plain \`[TAG]\` badge and a
stderr note, so a typo never blocks a send.

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

Always use \`tg\`, never direct curl to the Telegram API. tmux only.
`;

const SKILL_BLURB =
  '`tg` — send Telegram messages/files/reports: `tg "msg"`, ' +
  '`tg --format html "..."`, `tg --file f.pdf "cap"`, `tg --photo p.png`. ' +
  'Label messages with `--tag <ОТВЕТ|РЕШЕНИЕ|ПРОБЛЕМА|ОТЧЁТ>` ' +
  '(aliases ANSWER/DECISION/PROBLEM/REPORT) and set an explicit header line with ' +
  '`--title "..."` (the body is never pulled up). ' +
  'Attaching a code/config file (.ts/.json/.yaml/.py/…) renders a mobile, ' +
  'syntax-highlighted PDF and by DEFAULT sends ONLY the PDF (raw file is useless ' +
  'on iOS); `--with-original` sends both, `--no-pdf` sends the raw file. ' +
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendMarked(path: string, tool: string, blurb: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const start = `<!-- skill:${tool} -->`;
  const end = `<!-- /skill:${tool} -->`;
  let existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const re = new RegExp(escapeRegex(start) + '[\\s\\S]*?' + escapeRegex(end) + '\\n?', 'g');
  existing = existing.replace(re, '');
  const block = `${start}\n${blurb}\n${end}\n`;
  writeFileSync(path, existing.trim() ? existing.replace(/\s+$/, '') + '\n\n' + block : block);
}

// Idempotently add a SessionStart hook to ~/.claude/settings.json that surfaces
// installed agent CLIs. Conservative: never removes or rewrites unrelated config.
function ensureSessionStartHook(home: string): boolean {
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(join(home, '.claude'))) return false;
  let data: any;
  try {
    data = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
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
  if (existsSync(settingsPath)) writeFileSync(settingsPath + '.bak', readFileSync(settingsPath));
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

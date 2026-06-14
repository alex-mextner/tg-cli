import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installSkill } from '../features/install-skill/install';

// installSkill() resolves everything from os.homedir(), which honors $HOME on
// posix — so we point HOME at a throwaway dir and assert on what it writes.
// Harness detection (`command -v claude` || dir exists) is satisfied because we
// create $HOME/.claude, so the blurb path is exercised without a real harness.

let TH: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  TH = mkdtempSync(join(tmpdir(), 'tg-installskill-'));
  mkdirSync(join(TH, '.claude', 'skills'), { recursive: true });
  process.env.HOME = TH;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  rmSync(TH, { recursive: true, force: true });
});

test('writes SKILL.md, a blurb file, and the claude-skills symlink', () => {
  installSkill();
  expect(existsSync(join(TH, '.agents/skills/tg/SKILL.md'))).toBe(true);
  expect(existsSync(join(TH, '.agents/skills/.blurbs/tg.md'))).toBe(true);
  // ~/.claude/skills/tg -> ../../.agents/skills/tg
  expect(existsSync(join(TH, '.claude/skills/tg'))).toBe(true);
});

test('SKILL.md and the blurb advertise --tag / --title and the four canonical tags', () => {
  installSkill();
  const skill = readFileSync(join(TH, '.agents/skills/tg/SKILL.md'), 'utf8');
  // Flags are documented.
  expect(skill).toContain('--tag');
  expect(skill).toContain('--title');
  // All four canonical Russian tags + their English aliases + their meanings.
  for (const tag of ['ОТВЕТ', 'РЕШЕНИЕ', 'ПРОБЛЕМА', 'ОТЧЁТ']) {
    expect(skill).toContain(tag);
  }
  for (const alias of ['ANSWER', 'DECISION', 'PROBLEM', 'REPORT']) {
    expect(skill).toContain(alias);
  }
  // The body-is-never-pulled-up contract is stated.
  expect(skill.toLowerCase()).toContain('body');
  // The always-on blurb also mentions the flags + tags (agents that only see
  // the blurb still discover the convention).
  const blurb = readFileSync(join(TH, '.agents/skills/.blurbs/tg.md'), 'utf8');
  expect(blurb).toContain('--tag');
  expect(blurb).toContain('--title');
  expect(blurb).toContain('ОТВЕТ');
  expect(blurb).toContain('ОТЧЁТ');
});

test('blurb in CLAUDE.md is idempotent and preserves existing content', () => {
  writeFileSync(join(TH, '.claude', 'CLAUDE.md'), '# personal\n\nmy notes\n');
  installSkill();
  installSkill(); // second run must not duplicate the marked block
  const body = readFileSync(join(TH, '.claude', 'CLAUDE.md'), 'utf8');
  expect(body).toContain('# personal');
  expect(body.match(/<!-- skill:tg -->/g)?.length).toBe(1);
});

test('SessionStart hook is added once and preserves unrelated settings', () => {
  writeFileSync(
    join(TH, '.claude', 'settings.json'),
    JSON.stringify(
      { model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] } },
      null,
      2,
    ),
  );
  installSkill();
  installSkill();
  const data = JSON.parse(readFileSync(join(TH, '.claude', 'settings.json'), 'utf8'));
  expect(data.model).toBe('opus'); // unrelated config preserved
  const groups = data.hooks.SessionStart;
  expect(groups.length).toBe(2); // existing + ours, not duplicated on re-run
  const hasExisting = groups.some((g: any) => g.hooks.some((h: any) => h.command === 'echo keep-me'));
  const hasOurs = groups.some((g: any) =>
    g.hooks.some((h: any) => String(h.command).includes('agent-tools-awareness')),
  );
  expect(hasExisting).toBe(true);
  expect(hasOurs).toBe(true);
});

test('an unparseable settings.json is left untouched, not clobbered', () => {
  writeFileSync(join(TH, '.claude', 'settings.json'), '{ not valid json');
  expect(() => installSkill()).not.toThrow();
  expect(readFileSync(join(TH, '.claude', 'settings.json'), 'utf8')).toBe('{ not valid json');
});

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expandHome, hasRealExtension, isImagePath } from '../features/cli/args';
import { VERSION, latestChangelogSection, versionOutput } from '../features/cli/version';

// Focused unit tests for the pure CLI helpers extracted from the `tg`
// entrypoint (decomposition Stages 0c/0d). parseArgs itself is covered
// end-to-end by denylist/extensionless/recursive/worktree/ergonomics; here we
// pin the small path + version helpers that gained direct exports.

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tg-cli-helpers-'));
  dirs.push(d);
  return d;
}

// --- isImagePath ---
test('isImagePath accepts Telegram photo extensions, case-insensitively', () => {
  expect(isImagePath('shot.png')).toBe(true);
  expect(isImagePath('a.JPG')).toBe(true);
  expect(isImagePath('photo.jpeg')).toBe(true);
  expect(isImagePath('anim.gif')).toBe(true);
});

test('isImagePath rejects SVG (Telegram rejects it as a photo) and non-images', () => {
  expect(isImagePath('vector.svg')).toBe(false);
  expect(isImagePath('notes.txt')).toBe(false);
  expect(isImagePath('Makefile')).toBe(false);
  expect(isImagePath('noext')).toBe(false);
});

// --- hasRealExtension ---
test('hasRealExtension is true only for a basename dot with chars after it', () => {
  expect(hasRealExtension('a.ts')).toBe(true);
  expect(hasRealExtension('dir/sub/a.js')).toBe(true);
  expect(hasRealExtension('archive.tar.gz')).toBe(true);
});

test('hasRealExtension is false for extensionless names and leading-dot files', () => {
  expect(hasRealExtension('LICENSE')).toBe(false);
  expect(hasRealExtension('Makefile')).toBe(false);
  expect(hasRealExtension('.env')).toBe(false);
  expect(hasRealExtension('dir/.gitignore')).toBe(false);
});

// --- expandHome ---
test('expandHome expands ~ and ~/path, leaves absolute and relative tokens alone', () => {
  expect(expandHome('~', '/home/alex')).toBe('/home/alex');
  expect(expandHome('~/docs/a.txt', '/home/alex')).toBe('/home/alex/docs/a.txt');
  expect(expandHome('/abs/path', '/home/alex')).toBe('/abs/path');
  expect(expandHome('rel/path', '/home/alex')).toBe('rel/path');
  // a bare "~name" is NOT expanded (only "~" and "~/")
  expect(expandHome('~other', '/home/alex')).toBe('~other');
});

// --- latestChangelogSection ---
test('latestChangelogSection returns only the top-most ## section, trimmed', () => {
  const d = tmp();
  writeFileSync(
    join(d, 'CHANGELOG.md'),
    '# Changelog\n\n## 1.6.0\n\n- feat A\n- feat B\n\n## 1.5.0\n\n- old stuff\n',
  );
  expect(latestChangelogSection(d)).toBe('## 1.6.0\n\n- feat A\n- feat B');
});

test('latestChangelogSection degrades to "" with no changelog / no version heading', () => {
  expect(latestChangelogSection(tmp())).toBe('');
  const d = tmp();
  writeFileSync(join(d, 'CHANGELOG.md'), '# Changelog\n\nno version sections here\n');
  expect(latestChangelogSection(d)).toBe('');
});

// --- versionOutput ---
test('versionOutput composes the version+hash head and appends the changelog', () => {
  const d = tmp();
  writeFileSync(join(d, 'CHANGELOG.md'), '## 1.6.0\n\n- the latest\n');
  const out = versionOutput(d);
  // a non-git temp dir resolves the hash to "unknown" (never throws)
  expect(out.startsWith(`tg ${VERSION} (`)).toBe(true);
  expect(out).toContain('## 1.6.0');
  expect(out).toContain('- the latest');
});

test('versionOutput without a changelog is just the head line', () => {
  const out = versionOutput(tmp());
  expect(out).toBe(`tg ${VERSION} (unknown)`);
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseArgs } from '../features/cli/args';
import { VERSION } from '../tg';

// Real temp files for existence checks — no Telegram API is ever touched.
let dir: string;
let imgAbs: string;
let pdfAbs: string;
const HOME = '/home/tester';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-ergo-'));
  imgAbs = join(dir, 'shot.PNG'); // uppercase ext → case-insensitive check
  pdfAbs = join(dir, 'report.pdf');
  writeFileSync(imgAbs, 'fake');
  writeFileSync(pdfAbs, 'fake');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --- Ergonomic #2: help on empty / -h / --help anywhere ---
test('help wins anywhere; empty invocation resolves to help', () => {
  expect(parseArgs([], dir, HOME)).toEqual({ action: 'help' });
  expect(parseArgs(['-h'], dir, HOME)).toEqual({ action: 'help' });
  expect(parseArgs(['hi', '--help'], dir, HOME)).toEqual({ action: 'help' });
});

// --- Ergonomic #1: -v / --version ---
test('version flag wins anywhere', () => {
  expect(parseArgs(['-v'], dir, HOME)).toEqual({ action: 'version' });
  expect(parseArgs(['hi', '--version'], dir, HOME)).toEqual({ action: 'version' });
});

// The real script run as a subprocess: --version prints VERSION, a runtime git
// short hash (hex) or the graceful "unknown" fallback, and the latest CHANGELOG
// section. The version branch exits before any network call — no API hit. The
// hash is dynamic, so we assert robust tokens, not an exact byte match.
const TG_SCRIPT = join(import.meta.dir, '..', 'tg');

for (const flag of ['--version', '-v']) {
  test(`${flag} prints version + git hash + changelog, exit 0, no creds needed`, () => {
    const proc = Bun.spawnSync(['bun', TG_SCRIPT, flag], {
      // No TG_BOT_TOKEN / TG_CHAT_ID — version must work without credentials.
      env: { PATH: process.env.PATH ?? '', HOME: '/tmp/tg-cli-test-home' },
    });
    const out = proc.stdout.toString();
    expect(proc.exitCode).toBe(0);
    expect(out).toContain(VERSION);
    expect(out).toMatch(/\b([0-9a-f]{7,40}|unknown)\b/);
    // Stable changelog marker — the version heading, not prose we might reword.
    expect(out).toContain(`## ${VERSION}`);
  });
}

// --- Ergonomic #5: unknown dashed token → error (reconciliation point) ---
test('unknown dashed token is an error, not plain text', () => {
  expect(parseArgs(['--foo'], dir, HOME)).toEqual({
    action: 'error',
    message: 'unknown flag: --foo',
  });
  // The first unknown flag in the args is reported; text after it is irrelevant.
  expect(parseArgs(['-x', 'hello'], dir, HOME)).toEqual({
    action: 'error',
    message: 'unknown flag: -x',
  });
});

test('--bogus unknown flag → error (not sent as text)', () => {
  expect(parseArgs(['--bogus'], dir, HOME)).toEqual({
    action: 'error',
    message: 'unknown flag: --bogus',
  });
});

// --- Regression: every real flag main supports is still recognized, NOT
// treated as an unknown-dashed error (the core reconciliation requirement). ---
test("main's real flags are all recognized (no unknown-flag regression)", () => {
  // --ls-emoji-helpers and --detect-model win anywhere as dedicated actions.
  expect(parseArgs(['--ls-emoji-helpers'], dir, HOME)).toEqual({
    action: 'lsEmojiHelpers',
  });
  expect(parseArgs(['--detect-model'], dir, HOME)).toEqual({
    action: 'detectModel',
  });
  // --format is matched and validated, not errored as unknown.
  expect(parseArgs(['--format', 'html', 'hi'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hi',
    format: 'html',
  });
  expect(parseArgs(['--format', 'plain', 'hi'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hi',
    format: 'plain',
  });
  // --photo / --file are matched and consume a path value.
  expect(parseArgs(['--photo', imgAbs], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: '',
    format: 'plain',
  });
  expect(parseArgs(['--file', pdfAbs], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'document', path: pdfAbs }],
    caption: '',
    format: 'plain',
  });
});

// --- Regression: main's --format validation errors preserved (NOT changed) ---
test('--format validation errors are preserved from main', () => {
  expect(parseArgs(['--format'], dir, HOME)).toEqual({
    action: 'error',
    message: '--format requires plain or html',
  });
  expect(parseArgs(['--format', 'xml', 'hi'], dir, HOME)).toEqual({
    action: 'error',
    message: "unsupported format 'xml'. Accepted values: plain, html",
  });
});

// --- Regression: main's --photo/--file missing-path error preserved
// (this is where main's semantics differ from the reference branch, which
// returned help — we keep main's error). ---
test("--photo/--file with missing path → error (main's behavior, not help)", () => {
  expect(parseArgs(['--photo'], dir, HOME)).toEqual({
    action: 'error',
    message: '--photo requires a file path argument',
  });
  expect(parseArgs(['--file'], dir, HOME)).toEqual({
    action: 'error',
    message: '--file requires a file path argument',
  });
  // --photo followed by an unknown dashed token that is not a real file → the
  // flag has no valid path → error (the dashed token is in value position).
  expect(parseArgs(['--photo', '--foo'], dir, HOME)).toEqual({
    action: 'error',
    message: '--photo requires a file path argument',
  });
});

test('--file with a real dashed filename is still attached explicitly', () => {
  const dashed = join(dir, '-receipt.png');
  writeFileSync(dashed, 'fake');
  // Even though it starts with "-", it resolves to a real file → kept as the
  // explicit --file document (NOT reclassified as a photo by extension).
  expect(parseArgs(['--file', dashed], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'document', path: dashed }],
    caption: '',
    format: 'plain',
  });
  rmSync(dashed, { force: true });
});

test('--photo with a real RELATIVE dashed filename still attaches (flag value, not unknown flag)', () => {
  writeFileSync(join(dir, '-realfile.png'), 'fake');
  expect(parseArgs(['--photo', '-realfile.png'], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: '-realfile.png' }],
    caption: '',
    format: 'plain',
  });
  rmSync(join(dir, '-realfile.png'), { force: true });
});

// --- Ergonomic #3: auto-attach paths in message text ---
// CORE CORRECTION (spec §"never excise a path"): detected paths are KEPT in the
// caption verbatim — only the file is additionally attached. These cases used
// to assert excision; the CTO reversed that, so they now assert path-kept.
test('absolute image path in text → photo item, path KEPT in caption', () => {
  expect(parseArgs(['look', imgAbs, 'here'], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs, auto: true }],
    caption: `look ${imgAbs} here`,
    format: 'plain',
  });
});

test('absolute non-image path in text → document item, path KEPT', () => {
  expect(parseArgs([pdfAbs], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'document', path: pdfAbs, auto: true }],
    caption: pdfAbs,
    format: 'plain',
  });
});

test('auto-detected SVG in text → document (Telegram rejects SVG as photo), path KEPT', () => {
  const svgAbs = join(dir, 'diagram.svg');
  writeFileSync(svgAbs, '<svg/>');
  expect(parseArgs([svgAbs], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'document', path: svgAbs, auto: true }],
    caption: svgAbs,
    format: 'plain',
  });
  rmSync(svgAbs, { force: true });
});

test('relative existing file resolves against cwd, token KEPT in caption', () => {
  expect(parseArgs(['shot.PNG'], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs, auto: true }],
    caption: 'shot.PNG',
    format: 'plain',
  });
});

test('path inside a quoted single argv token is detected, KEPT in caption', () => {
  expect(parseArgs([`look at ${imgAbs} please`], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs, auto: true }],
    caption: `look at ${imgAbs} please`,
    format: 'plain',
  });
});

test('non-existent path token stays as text', () => {
  expect(parseArgs(['/nope/does-not-exist.png', 'hi'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '/nope/does-not-exist.png hi',
    format: 'plain',
  });
});

test('ordinary words that are not files stay as text', () => {
  expect(parseArgs(['hello', 'world'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hello world',
    format: 'plain',
  });
});

test('directory token is NOT treated as a file', () => {
  expect(parseArgs([dir, 'msg'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: `${dir} msg`,
    format: 'plain',
  });
});

test('~ home expansion resolves to a real file, token KEPT in caption', () => {
  // home = dir for this case so ~/shot.PNG resolves to imgAbs.
  expect(parseArgs(['~/shot.PNG'], '/some/other/cwd', dir)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs, auto: true }],
    caption: '~/shot.PNG',
    format: 'plain',
  });
});

test('explicit --photo takes precedence: same file not attached twice, text path KEPT', () => {
  expect(parseArgs(['--photo', imgAbs, imgAbs, 'cap'], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: `${imgAbs} cap`,
    format: 'plain',
  });
});

test('explicit --file plus auto-detected photo → media group, text path KEPT', () => {
  expect(parseArgs(['--file', pdfAbs, imgAbs, 'both'], dir, HOME)).toEqual({
    action: 'send',
    items: [
      // Explicit --file → no `auto`; auto-detected photo → `auto: true`.
      { type: 'document', path: pdfAbs },
      { type: 'photo', path: imgAbs, auto: true },
    ],
    caption: `${imgAbs} both`,
    format: 'plain',
  });
});

// --- Whitespace preservation (caption formatting) ---
test('plain multi-line / multi-space text preserves whitespace exactly', () => {
  const msg = 'line1\nline2\n\n  indented';
  expect(parseArgs([msg], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: msg,
    format: 'plain',
  });
  expect(parseArgs(['a    b'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'a    b',
    format: 'plain',
  });
});

test('caption around a detected path keeps the path AND surrounding formatting', () => {
  expect(parseArgs([`top\n${imgAbs}\nbottom`], dir, HOME)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs, auto: true }],
    caption: `top\n${imgAbs}\nbottom`,
    format: 'plain',
  });
});

// --- Feature OFF path: auto-attach disabled → no text-path scanning ---
test('auto-attach OFF: path in text is NOT attached, stays as plain text', () => {
  expect(parseArgs(['look', imgAbs, 'here'], dir, HOME, false)).toEqual({
    action: 'send',
    items: [],
    caption: `look ${imgAbs} here`,
    format: 'plain',
  });
});

test('auto-attach OFF: explicit --photo/--file still attach', () => {
  expect(parseArgs(['--photo', imgAbs, 'cap'], dir, HOME, false)).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: 'cap',
    format: 'plain',
  });
});

// --- Line-spec: file.ts:N / :N-M / :N:C detected, token KEPT in caption ---
test('line-spec :N on an existing file → attached with lineSpec, token KEPT', () => {
  const tsAbs = join(dir, 'mod.ts');
  writeFileSync(tsAbs, 'a\nb\nc\nd\ne');
  const r = parseArgs([`see ${tsAbs}:3`], dir, HOME);
  expect(r).toEqual({
    action: 'send',
    items: [
      {
        type: 'document',
        path: tsAbs,
        // Auto-detected from the text → carries `auto: true` (provenance marker;
        // explicit --file/--photo items don't carry it).
        auto: true,
        lineSpec: { token: `${tsAbs}:3`, startLine: 3, endLine: 3, col: undefined },
      },
    ],
    caption: `see ${tsAbs}:3`,
    format: 'plain',
  });
  rmSync(tsAbs, { force: true });
});

test('line-spec :N-M range and :N:C column parse onto the item', () => {
  const tsAbs = join(dir, 'mod2.ts');
  writeFileSync(tsAbs, 'a\nb\nc\nd\ne\nf');
  const range = parseArgs([`${tsAbs}:2-4`], dir, HOME);
  expect(range.action).toBe('send');
  if (range.action === 'send') {
    expect(range.items[0].lineSpec).toEqual({
      token: `${tsAbs}:2-4`,
      startLine: 2,
      endLine: 4,
      col: undefined,
    });
  }
  const col = parseArgs([`${tsAbs}:2:5`], dir, HOME);
  if (col.action === 'send') {
    expect(col.items[0].lineSpec).toEqual({
      token: `${tsAbs}:2:5`,
      startLine: 2,
      endLine: 2,
      col: 5,
    });
  }
  rmSync(tsAbs, { force: true });
});

test('line-spec on a NON-existent file → plain text, no attach', () => {
  expect(parseArgs(['/nope/x.ts:42', 'hi'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '/nope/x.ts:42 hi',
    format: 'plain',
  });
});

test('line-spec mention of an already --file-attached file adopts the spec', () => {
  const tsAbs = join(dir, 'adopt.ts');
  writeFileSync(tsAbs, 'a\nb\nc\nd\ne');
  // --file attaches with no spec; the text mention carries :3 → adopted.
  const r = parseArgs(['--file', tsAbs, `see ${tsAbs}:3`], dir, HOME);
  expect(r).toEqual({
    action: 'send',
    items: [
      {
        type: 'document',
        path: tsAbs,
        lineSpec: { token: `${tsAbs}:3`, startLine: 3, endLine: 3, col: undefined },
      },
    ],
    caption: `see ${tsAbs}:3`,
    format: 'plain',
  });
  rmSync(tsAbs, { force: true });
});

test('plain existing path with no spec has NO lineSpec field', () => {
  const r = parseArgs([pdfAbs], dir, HOME);
  expect(r).toEqual({
    action: 'send',
    items: [{ type: 'document', path: pdfAbs, auto: true }],
    caption: pdfAbs,
    format: 'plain',
  });
  // No spec: the lineSpec field is absent, not undefined.
  if (r.action === 'send') expect('lineSpec' in r.items[0]).toBe(false);
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseArgs } from './tg';

// Real temp files for existence checks — no Telegram API is ever touched.
let dir: string;
let imgAbs: string;
let pdfAbs: string;
const HOME = '/home/tester';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-test-'));
  imgAbs = join(dir, 'shot.PNG'); // uppercase ext → case-insensitive check
  pdfAbs = join(dir, 'report.pdf');
  writeFileSync(imgAbs, 'fake');
  writeFileSync(pdfAbs, 'fake');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('help/version flags win anywhere', () => {
  expect(parseArgs([], dir, HOME)).toEqual({ action: 'help' });
  expect(parseArgs(['-h'], dir, HOME)).toEqual({ action: 'help' });
  expect(parseArgs(['hi', '--help'], dir, HOME)).toEqual({ action: 'help' });
  expect(parseArgs(['-v'], dir, HOME)).toEqual({ action: 'version' });
  expect(parseArgs(['hi', '--version'], dir, HOME)).toEqual({ action: 'version' });
});

test('unknown dashed token becomes plain text', () => {
  expect(parseArgs(['--foo'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '--foo',
  });
  expect(parseArgs(['-x', 'hello'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '-x hello',
  });
});

test('--photo followed by unknown flag does not crash', () => {
  // --photo has no real path → dropped; --foo is text.
  expect(parseArgs(['--photo', '--foo'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: '--foo',
  });
});

test('--photo at end with no path falls through to help', () => {
  expect(parseArgs(['--photo'], dir, HOME)).toEqual({ action: 'help' });
});

test('plain multi-line / multi-space text preserves whitespace exactly', () => {
  // No paths to attach → caption must be byte-identical (no whitespace collapse).
  const msg = 'line1\nline2\n\n  indented';
  expect(parseArgs([msg], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: msg,
  });
  // Multiple spaces between words preserved.
  expect(parseArgs(['a    b'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'a    b',
  });
});

test('caption around an excised path keeps surrounding formatting', () => {
  const res = parseArgs([`top\n${imgAbs}\nbottom`], dir, HOME);
  // The path line is excised; the rest of the formatting is preserved.
  expect(res).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: 'top\nbottom',
  });
});

test('--file with a real dashed filename is still attached explicitly', () => {
  const dashed = join(dir, '-receipt.png');
  writeFileSync(dashed, 'fake');
  // Even though it starts with "-", it resolves to a real file → kept as the
  // explicit --file document (NOT reclassified as a photo by extension).
  const res = parseArgs(['--file', dashed], dir, HOME);
  expect(res).toEqual({
    action: 'send',
    items: [{ type: 'document', path: dashed }],
    caption: '',
  });
  rmSync(dashed, { force: true });
});

test('absolute image path in text → photo item, stripped from caption', () => {
  const res = parseArgs(['look', imgAbs, 'here'], dir, HOME);
  expect(res).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: 'look here',
  });
});

test('absolute non-image path in text → document item', () => {
  const res = parseArgs([pdfAbs], dir, HOME);
  expect(res).toEqual({
    action: 'send',
    items: [{ type: 'document', path: pdfAbs }],
    caption: '',
  });
});

test('relative existing file resolves against cwd', () => {
  // cwd = dir, so "shot.PNG" should resolve to imgAbs.
  const res = parseArgs(['shot.PNG'], dir, HOME);
  expect(res).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: '',
  });
});

test('path inside a quoted single argv token is detected', () => {
  const res = parseArgs([`look at ${imgAbs} please`], dir, HOME);
  expect(res).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: 'look at please',
  });
});

test('non-existent path token stays as text', () => {
  const res = parseArgs(['/nope/does-not-exist.png', 'hi'], dir, HOME);
  expect(res).toEqual({
    action: 'send',
    items: [],
    caption: '/nope/does-not-exist.png hi',
  });
});

test('ordinary word that is not a file stays as text', () => {
  expect(parseArgs(['hello', 'world'], dir, HOME)).toEqual({
    action: 'send',
    items: [],
    caption: 'hello world',
  });
});

test('directory token is NOT treated as a file', () => {
  const res = parseArgs([dir, 'msg'], dir, HOME);
  expect(res).toEqual({
    action: 'send',
    items: [],
    caption: `${dir} msg`,
  });
});

test('~ home expansion resolves to a real file', () => {
  // home = dir for this case so ~/shot.PNG resolves to imgAbs.
  const res = parseArgs(['~/shot.PNG'], '/some/other/cwd', dir);
  expect(res).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: '',
  });
});

test('explicit --photo takes precedence: same file not attached twice', () => {
  const res = parseArgs(['--photo', imgAbs, imgAbs, 'cap'], dir, HOME);
  expect(res).toEqual({
    action: 'send',
    items: [{ type: 'photo', path: imgAbs }],
    caption: 'cap',
  });
});

test('explicit --file plus auto-detected photo → media group', () => {
  const res = parseArgs(['--file', pdfAbs, imgAbs, 'both'], dir, HOME);
  expect(res).toEqual({
    action: 'send',
    items: [
      { type: 'document', path: pdfAbs },
      { type: 'photo', path: imgAbs },
    ],
    caption: 'both',
  });
});

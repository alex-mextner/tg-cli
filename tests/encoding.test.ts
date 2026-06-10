import { expect, test } from 'bun:test';
import { BOM_MAX_BYTES, maybeAddBom, UTF8_BOM } from '../features/auto-attach/encoding';
import { fileUrl, findChrome, isConvertibleMd, pdfNameFor } from '../features/md-pdf/convert';
import type { SendItem } from '../features/auto-attach/types';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// --- maybeAddBom ---

test('bom: Cyrillic UTF-8 .md gets a BOM prefix', () => {
  const out = maybeAddBom(enc('# Привет'), 'report.md');
  expect(out.slice(0, 3)).toEqual(UTF8_BOM);
  expect(new TextDecoder().decode(out.slice(3))).toBe('# Привет');
});

test('bom: pure-ASCII text is left untouched', () => {
  const bytes = enc('hello world');
  expect(maybeAddBom(bytes, 'a.txt')).toBe(bytes);
});

test('bom: existing BOM is not doubled', () => {
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('Привет')]);
  expect(maybeAddBom(withBom, 'a.txt')).toBe(withBom);
});

test('bom: non-whitelisted extensions are untouched (sh, json, png, none)', () => {
  const cyr = enc('# Привет');
  for (const name of ['run.sh', 'data.json', 'img.png', 'LICENSE', '.env']) {
    expect(maybeAddBom(cyr, name)).toBe(cyr);
  }
});

test('bom: invalid UTF-8 is untouched', () => {
  const bad = new Uint8Array([0x23, 0x20, 0xc3, 0x28]); // truncated/invalid sequence
  expect(maybeAddBom(bad, 'a.txt')).toBe(bad);
});

test('bom: NUL byte means binary — untouched', () => {
  const nul = new Uint8Array([0xd0, 0x9f, 0x00, 0x41]);
  expect(maybeAddBom(nul, 'a.txt')).toBe(nul);
});

test('bom: oversized content is untouched', () => {
  const big = new Uint8Array(BOM_MAX_BYTES + 1).fill(0xd0);
  expect(maybeAddBom(big, 'a.txt')).toBe(big);
});

test('bom: Cyrillic code comment in .ts gets a BOM', () => {
  const out = maybeAddBom(enc('// комментарий\nconst x = 1\n'), 'x.ts');
  expect(out.slice(0, 3)).toEqual(UTF8_BOM);
});

// --- md-pdf pure helpers ---

const disk = (path: string, type: 'photo' | 'document' = 'document'): SendItem => ({
  type,
  source: { kind: 'disk', path },
});

test('md-pdf: disk .md/.markdown documents are convertible', () => {
  expect(isConvertibleMd(disk('/x/report.md'))).toBe(true);
  expect(isConvertibleMd(disk('/x/report.markdown'))).toBe(true);
});

test('md-pdf: memory sources, photos, other exts are not convertible', () => {
  expect(isConvertibleMd({ type: 'document', source: { kind: 'memory', filename: 'a.md', content: 'x' } })).toBe(false);
  expect(isConvertibleMd(disk('/x/a.md', 'photo'))).toBe(false);
  expect(isConvertibleMd(disk('/x/a.txt'))).toBe(false);
  expect(isConvertibleMd(disk('/x/README'))).toBe(false);
});

test('md-pdf: pdfNameFor keeps the basename', () => {
  expect(pdfNameFor('/long/path/отчёт тест.md')).toBe('отчёт тест.pdf');
  expect(pdfNameFor('/x/REPORT.MARKDOWN')).toBe('REPORT.pdf');
});

test('md-pdf: fileUrl percent-encodes non-ASCII and spaces', () => {
  expect(fileUrl('/tmp/отчёт тест.html')).toBe(
    'file:///tmp/%D0%BE%D1%82%D1%87%D1%91%D1%82%20%D1%82%D0%B5%D1%81%D1%82.html',
  );
  expect(fileUrl('/tmp/plain.html')).toBe('file:///tmp/plain.html');
});

test('md-pdf: findChrome honors TG_CHROME_PATH and falls back to candidates', () => {
  const existing = new Set(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
  const deps = {
    fileExists: (p: string) => existing.has(p),
    whichCmd: () => null,
    env: {} as Record<string, string | undefined>,
  };
  expect(findChrome(deps)).toContain('Google Chrome');
  expect(findChrome({ ...deps, env: { TG_CHROME_PATH: '/custom/chrome' } })).toBeNull();
  existing.add('/custom/chrome');
  expect(findChrome({ ...deps, env: { TG_CHROME_PATH: '/custom/chrome' } })).toBe('/custom/chrome');
});

test('md-pdf: findChrome probes PATH names when no absolute candidate exists', () => {
  const deps = {
    fileExists: () => false,
    whichCmd: (name: string) => (name === 'chromium-browser' ? '/snap/bin/chromium-browser' : null),
    env: {} as Record<string, string | undefined>,
  };
  expect(findChrome(deps)).toBe('/snap/bin/chromium-browser');
  expect(findChrome({ ...deps, whichCmd: () => null })).toBeNull();
});

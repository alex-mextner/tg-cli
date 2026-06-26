import { expect, test } from 'bun:test';
import {
  applyCodePdfToPlan,
  CODE_EXT_LANG,
  codeCss,
  type CodePdfRunner,
  DEFAULT_DEVICE,
  DEVICE_PRESETS,
  detectCodeLang,
  fenceContent,
  isConvertibleCode,
  pdfNameForCode,
  resolveDevice,
} from '../features/code-pdf/convert';
import type { ConvertOutcome } from '../features/md-pdf/convert';
import type { SendItem } from '../features/auto-attach/types';

const disk = (path: string, type: 'photo' | 'document' = 'document'): SendItem => ({
  type,
  source: { kind: 'disk', path },
});

// --- Type detection -------------------------------------------------------

test('detectCodeLang: code/config extensions map to highlight languages', () => {
  expect(detectCodeLang('/x/server.ts')).toBe('typescript');
  expect(detectCodeLang('/x/Component.tsx')).toBe('typescript');
  expect(detectCodeLang('/x/index.js')).toBe('javascript');
  expect(detectCodeLang('/x/App.jsx')).toBe('javascript');
  expect(detectCodeLang('/x/config.mjs')).toBe('javascript');
  expect(detectCodeLang('/x/package.json')).toBe('json');
  expect(detectCodeLang('/x/tsconfig.jsonc')).toBe('json');
  expect(detectCodeLang('/x/compose.yaml')).toBe('yaml');
  expect(detectCodeLang('/x/ci.yml')).toBe('yaml');
  expect(detectCodeLang('/x/Cargo.toml')).toBe('toml');
  expect(detectCodeLang('/x/setup.ini')).toBe('ini');
  expect(detectCodeLang('/x/main.py')).toBe('python');
  expect(detectCodeLang('/x/main.go')).toBe('go');
  expect(detectCodeLang('/x/lib.rs')).toBe('rust');
  expect(detectCodeLang('/x/app.rb')).toBe('ruby');
  expect(detectCodeLang('/x/index.php')).toBe('php');
  expect(detectCodeLang('/x/Main.java')).toBe('java');
  expect(detectCodeLang('/x/Main.kt')).toBe('kotlin');
  expect(detectCodeLang('/x/App.swift')).toBe('swift');
  expect(detectCodeLang('/x/run.sh')).toBe('bash');
  expect(detectCodeLang('/x/.zshrc.zsh')).toBe('zsh');
  expect(detectCodeLang('/x/query.sql')).toBe('sql');
  expect(detectCodeLang('/x/styles.css')).toBe('css');
  expect(detectCodeLang('/x/styles.scss')).toBe('scss');
  expect(detectCodeLang('/x/styles.less')).toBe('css');
  // .html/.htm are NOT code-fence types — they take the HTML render path
  // (issue #95). Asserted in tests/html-pdf.test.ts.
  expect(detectCodeLang('/x/page.html')).toBeNull();
  expect(detectCodeLang('/x/component.vue')).toBe('html'); // .vue stays source
  expect(detectCodeLang('/x/data.xml')).toBe('xml');
  expect(detectCodeLang('/x/icon.svg')).toBe('xml');
  expect(detectCodeLang('/x/schema.graphql')).toBe('graphql');
  expect(detectCodeLang('/x/api.proto')).toBe('protobuf');
  expect(detectCodeLang('/x/init.lua')).toBe('lua');
  expect(detectCodeLang('/x/analysis.r')).toBe('r');
  expect(detectCodeLang('/x/main.dart')).toBe('dart');
});

test('detectCodeLang: extensionless code files map by basename', () => {
  expect(detectCodeLang('/x/Dockerfile')).toBe('dockerfile');
  expect(detectCodeLang('/x/Makefile')).toBe('makefile');
  expect(detectCodeLang('/x/CMakeLists.txt')).toBe('cmake');
  expect(detectCodeLang('/x/Gemfile')).toBe('ruby');
  expect(detectCodeLang('/x/.gitignore')).toBe('bash');
});

test('detectCodeLang: non-code types return null', () => {
  expect(detectCodeLang('/x/report.md')).toBeNull(); // markdown stays on md-pdf path
  expect(detectCodeLang('/x/report.markdown')).toBeNull();
  expect(detectCodeLang('/x/photo.png')).toBeNull();
  expect(detectCodeLang('/x/doc.pdf')).toBeNull();
  expect(detectCodeLang('/x/notes.txt')).toBeNull();
  expect(detectCodeLang('/x/archive.zip')).toBeNull();
  expect(detectCodeLang('/x/LICENSE')).toBeNull();
});

test('detectCodeLang: Object.prototype keys are NOT languages (prototype-pollution guard)', () => {
  // A file named x.constructor / x.toString / proto.hasOwnProperty must be null,
  // not a Function inherited from Object.prototype via `in`/bracket access.
  for (const proto of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    expect(detectCodeLang(`/x/file.${proto}`)).toBeNull();
    expect(detectCodeLang(`/x/${proto}`)).toBeNull();
  }
});

test('isConvertibleCode: only disk-sourced code documents', () => {
  expect(isConvertibleCode(disk('/x/server.ts'))).toBe(true);
  expect(isConvertibleCode(disk('/x/data.json'))).toBe(true);
  expect(isConvertibleCode(disk('/x/report.md'))).toBe(false); // md → md-pdf
  expect(isConvertibleCode(disk('/x/server.ts', 'photo'))).toBe(false); // wrong type
  expect(isConvertibleCode({ type: 'document', source: { kind: 'memory', filename: 'a.ts', content: 'x' } })).toBe(
    false,
  ); // memory source
});

test('pdfNameForCode: keeps the full original name so .ts vs .json stays visible', () => {
  expect(pdfNameForCode('/dir/config.ts')).toBe('config.ts.pdf');
  expect(pdfNameForCode('/dir/config.json')).toBe('config.json.pdf');
  expect(pdfNameForCode('/dir/Dockerfile')).toBe('Dockerfile.pdf');
});

test('CODE_EXT_LANG values are non-empty highlight language strings', () => {
  for (const [ext, lang] of Object.entries(CODE_EXT_LANG)) {
    expect(typeof lang).toBe('string');
    expect(lang.length).toBeGreaterThan(0);
    expect(ext).not.toContain('.');
  }
});

// --- Device presets -------------------------------------------------------

test('resolveDevice: default is iphone15pro, narrow phone width', () => {
  const { name, preset, unknown } = resolveDevice(undefined, {});
  expect(name).toBe('iphone15pro');
  expect(unknown).toBe(false);
  expect(preset.widthPt).toBe(393);
  // A phone page must be much narrower than A4 (595pt) — no horizontal scroll.
  expect(preset.widthPt).toBeLessThan(DEVICE_PRESETS.a4.widthPt);
});

test('resolveDevice: flag wins over env, env wins over default', () => {
  expect(resolveDevice('a4', {}).name).toBe('a4');
  expect(resolveDevice(undefined, { TG_PDF_DEVICE: 'iphonese' }).name).toBe('iphonese');
  expect(resolveDevice('a4', { TG_PDF_DEVICE: 'iphonese' }).name).toBe('a4');
});

test('resolveDevice: unknown device falls back to the default and flags it', () => {
  const { name, unknown } = resolveDevice('nokia3310', {});
  expect(name).toBe(DEFAULT_DEVICE);
  expect(unknown).toBe(true);
});

test('resolveDevice: Object.prototype keys are unknown, not a Function preset', () => {
  // `--pdf-device constructor` must resolve to the default preset (real numbers),
  // not Object.prototype.constructor → @page { size: undefinedpt … }.
  for (const proto of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const { name, preset, unknown } = resolveDevice(proto, {});
    expect(unknown).toBe(true);
    expect(name).toBe(DEFAULT_DEVICE);
    expect(typeof preset.widthPt).toBe('number');
    expect(preset.widthPt).toBeGreaterThan(0);
  }
});

test('all device presets exist with sane geometry', () => {
  for (const preset of Object.values(DEVICE_PRESETS)) {
    expect(preset.widthPt).toBeGreaterThan(0);
    expect(preset.heightPt).toBeGreaterThan(preset.widthPt); // portrait
    expect(preset.fontPt).toBeGreaterThan(8);
    expect(preset.fontPt).toBeLessThan(16);
  }
});

// --- Fencing --------------------------------------------------------------

test('fenceContent: wraps content in a fenced block tagged with the language', () => {
  const out = fenceContent('const x = 1;', 'typescript');
  // Attribute fence form (needs pandoc's markdown reader): {.lang}
  expect(out.startsWith('```{.typescript}\n')).toBe(true);
  expect(out).toContain('const x = 1;');
  expect(out.trimEnd().endsWith('```')).toBe(true);
});

test('fenceContent: uses a longer fence than any backtick run in the content', () => {
  // content already contains a triple-backtick fence — ours must be longer.
  const out = fenceContent('```\nnested\n```', 'markdown');
  expect(out.startsWith('````')).toBe(true); // 4+ backticks
});

test('fenceContent: lineNumbers uses pandoc attribute form', () => {
  const out = fenceContent('x', 'typescript', true);
  expect(out).toContain('{.typescript .numberLines}');
});

test('fenceContent: appends a trailing newline when the file lacks one', () => {
  const out = fenceContent('no final newline', 'go');
  expect(out).toContain('no final newline\n```');
});

// --- CSS: mobile + soft-wrap (the critical no-horizontal-scroll rules) -----

test('codeCss: emits the @page size for the device width (mobile dims)', () => {
  const css = codeCss(DEVICE_PRESETS.iphone15pro, false);
  expect(css).toContain('@page');
  expect(css).toContain('393pt'); // iPhone 15 Pro width
});

test('codeCss: soft-wraps long lines so there is NO horizontal scroll', () => {
  const css = codeCss(DEVICE_PRESETS.iphone15pro, false);
  expect(css).toContain('white-space: pre-wrap');
  expect(css).toContain('overflow-wrap: anywhere');
  // <pre> must NOT be allowed to scroll horizontally on a phone.
  expect(css).not.toContain('overflow-x: auto');
});

test('codeCss: uses a monospace font stack and a readable size', () => {
  const css = codeCss(DEVICE_PRESETS.iphone15pro, false);
  expect(css.toLowerCase()).toContain('monospace');
  expect(css).toContain('12pt'); // iphone15pro font size
});

test('codeCss: line-number gutter styles appear only when enabled', () => {
  expect(codeCss(DEVICE_PRESETS.iphone15pro, true)).toContain('numberSource');
  expect(codeCss(DEVICE_PRESETS.iphone15pro, false)).not.toContain('numberSource');
});

// --- applyCodePdfToPlan: the default (PDF-only) + flags (the spec's core) ---

// A runner that "renders" a code file by returning a deterministic PDF path.
const okRunner: CodePdfRunner = {
  convert: (codePath): ConvertOutcome => ({
    pdfPath: `/tmp/rendered/${codePath.slice(codePath.lastIndexOf('/') + 1)}.pdf`,
    error: null,
    tmpDir: `/tmp/render-${codePath.slice(codePath.lastIndexOf('/') + 1)}`,
  }),
};
const failRunner: CodePdfRunner = {
  convert: (): ConvertOutcome => ({ pdfPath: null, error: 'chrome boom', tmpDir: '/tmp/x' }),
};

const paths = (items: SendItem[]): string[] =>
  items.map((it) => (it.source.kind === 'disk' ? it.source.path : `memory:${it.source.filename}`));

test('DEFAULT: a code file becomes PDF-ONLY — the original is NOT attached', () => {
  const { documents } = applyCodePdfToPlan([disk('/proj/server.ts')], okRunner);
  expect(paths(documents)).toEqual(['/tmp/rendered/server.ts.pdf']);
  // The raw .ts must be gone from the plan.
  expect(paths(documents)).not.toContain('/proj/server.ts');
});

test('--with-original: BOTH the PDF and the raw original are attached', () => {
  const { documents } = applyCodePdfToPlan([disk('/proj/config.json')], okRunner, {
    withOriginal: true,
  });
  expect(paths(documents)).toContain('/tmp/rendered/config.json.pdf');
  expect(paths(documents)).toContain('/proj/config.json');
  // PDF first, original after.
  expect(paths(documents)).toEqual(['/tmp/rendered/config.json.pdf', '/proj/config.json']);
});

test('conversion FAILURE keeps the original attached unchanged + reports it + surfaces the temp dir for cleanup', () => {
  const { documents, failures, failedTmpDirs } = applyCodePdfToPlan([disk('/proj/a.ts')], failRunner);
  expect(paths(documents)).toEqual(['/proj/a.ts']); // original stays
  expect(failures).toEqual([{ path: '/proj/a.ts', error: 'chrome boom' }]);
  // The failed render's temp dir must be returned so the caller can drop it
  // immediately (nothing from it rides) — otherwise it leaks /tmp.
  expect(failedTmpDirs).toEqual(['/tmp/x']);
});

test('FAIL-OPEN: a converter that THROWS keeps the original (never aborts the send)', () => {
  // e.g. mkdtemp/writeFile blowing up on an unwritable/full TMPDIR.
  const throwingRunner: CodePdfRunner = {
    convert: () => {
      throw new Error('ENOSPC: no space left on device');
    },
  };
  const { documents, failures, failedTmpDirs } = applyCodePdfToPlan([disk('/proj/a.ts')], throwingRunner);
  expect(paths(documents)).toEqual(['/proj/a.ts']); // original survives
  expect(failures).toEqual([{ path: '/proj/a.ts', error: 'ENOSPC: no space left on device' }]);
  expect(failedTmpDirs).toEqual([]); // nothing created
});

test('NON-code documents (.md, .pdf, .txt) flow through UNCHANGED', () => {
  const docs = [disk('/x/report.md'), disk('/x/doc.pdf'), disk('/x/notes.txt')];
  const { documents, failures, tmpDirs } = applyCodePdfToPlan(docs, okRunner, {
    withOriginal: true,
  });
  // None converted: same three docs, untouched, no failures, no temp dirs.
  expect(paths(documents)).toEqual(['/x/report.md', '/x/doc.pdf', '/x/notes.txt']);
  expect(failures).toEqual([]);
  expect(tmpDirs).toEqual([]);
});

test('resolveDevice surfaces the requested value and its source (for warnings)', () => {
  const fromFlag = resolveDevice('nokia3310', {});
  expect(fromFlag.unknown).toBe(true);
  expect(fromFlag.requested).toBe('nokia3310');
  expect(fromFlag.source).toBe('flag');

  // A bad value from the ENV must report 'env' + the env value (not 'undefined').
  const fromEnv = resolveDevice(undefined, { TG_PDF_DEVICE: 'pixel99' });
  expect(fromEnv.unknown).toBe(true);
  expect(fromEnv.requested).toBe('pixel99');
  expect(fromEnv.source).toBe('env');

  const def = resolveDevice(undefined, {});
  expect(def.unknown).toBe(false);
  expect(def.source).toBe('default');
});

test('memory-sourced code docs are NOT rendered (line-spec marker copies)', () => {
  const memDoc: SendItem = {
    type: 'document',
    source: { kind: 'memory', filename: 'marked.ts', content: 'x' },
  };
  const { documents } = applyCodePdfToPlan([memDoc], okRunner);
  expect(documents).toEqual([memDoc]); // untouched
});

test('mixed plan: code → PDF-only, non-code untouched, order preserved', () => {
  const { documents } = applyCodePdfToPlan([disk('/x/a.ts'), disk('/x/readme.md'), disk('/x/b.json')], okRunner);
  expect(paths(documents)).toEqual(['/tmp/rendered/a.ts.pdf', '/x/readme.md', '/tmp/rendered/b.json.pdf']);
});

test('successful renders collect their temp dirs for cleanup', () => {
  const { tmpDirs } = applyCodePdfToPlan([disk('/x/a.ts'), disk('/x/b.yaml')], okRunner);
  expect(tmpDirs).toEqual(['/tmp/render-a.ts', '/tmp/render-b.yaml']);
});

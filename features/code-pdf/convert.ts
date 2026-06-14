// code-as-pdf feature: code/config files (.ts, .json, .yaml, …) that Telegram's
// iOS client previews poorly are rendered to a mobile-sized, syntax-highlighted
// PDF before upload. On a phone the raw .ts is unreadable — a wrapped,
// monospace, highlighted PDF sized for the screen is the readable artifact.
//
// BY DEFAULT only the PDF is sent (the original is NOT attached): "по умолчанию
// оригинал не шли". `--with-original` attaches both; `--no-pdf` (or disabling
// the feature) keeps today's behavior (original only).
//
// Pipeline reuses the md-pdf machinery: wrap the file content in a fenced code
// block tagged with the detected language → pandoc (gfm → standalone html5,
// skylighting syntax highlighting) → headless Chrome --print-to-pdf with a
// mobile @page size. Soft-wrap is enforced in CSS (white-space: pre-wrap +
// overflow-wrap: anywhere) so there is NO horizontal scroll on a phone.
//
// Scope: DISK-sourced files whose extension/basename maps to a code/config type
// Telegram iOS mangles. Markdown stays on the md-pdf path; images / .pdf / other
// documents are untouched.
//
// Failure policy (inherited): any missing tool / non-zero exit / timeout leaves
// the original file attached unchanged with a one-line stderr warning.
// Conversion must never block or fail a send.

import type { SendItem } from '../auto-attach/types';
import { type ConvertDeps, type ConvertOutcome, fileUrl, findChrome } from '../md-pdf/convert';

// --- Type detection -------------------------------------------------------
//
// Map a file EXTENSION (lowercase, no dot) to the pandoc/skylighting highlight
// language used for the fenced block. The key set is the source of truth for
// "is this a code/config file Telegram iOS previews poorly?" — if an extension
// is here, it is convertible. Values are pandoc highlight languages (see
// `pandoc --list-highlight-languages`); where pandoc has no dedicated
// highlighter we point at the closest superset (tsx→typescript, jsx→javascript,
// less→css, …) so the output is still highlighted, never a hard failure.
//
// Keep this map MAINTAINABLE: one line per extension, grouped by family. Add a
// new code/config type by adding one entry.
export const CODE_EXT_LANG: Record<string, string> = {
  // JS/TS family
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // Data / config
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'bash',
  // Python / Ruby / PHP
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  php: 'php',
  // Compiled / systems
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  hh: 'cpp',
  cs: 'cs',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  m: 'objectivec',
  mm: 'objectivec',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  pm: 'perl',
  groovy: 'groovy',
  gradle: 'groovy',
  nix: 'nix',
  hs: 'haskell',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  clj: 'clojure',
  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  fish: 'bash',
  ps1: 'powershell',
  // Query / markup / web
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  vue: 'html',
  // Build / infra
  dockerfile: 'dockerfile',
  cmake: 'cmake',
  diff: 'diff',
  patch: 'diff',
};

// Some code/config files have NO extension — their basename (lowercased) is the
// type. Maps the bare filename to a highlight language.
export const CODE_FILENAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  gemfile: 'ruby',
  rakefile: 'ruby',
  procfile: 'bash',
  '.gitignore': 'bash',
  '.dockerignore': 'bash',
};

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extOf(name: string): string {
  const base = basenameOf(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Detect the highlight language for a code/config file, or null when the file
 * is not a code/config type (and so should not be rendered as a code PDF).
 * Checks the full lowercased basename first (Dockerfile, Makefile, .gitignore),
 * then the extension.
 */
export function detectCodeLang(path: string): string | null {
  // Object.hasOwn (NOT `in`/bracket access alone): a file literally named
  // `x.constructor` / `x.toString` / `proto.hasOwnProperty` would otherwise
  // match an inherited Object.prototype key and return a Function, not null.
  const base = basenameOf(path).toLowerCase();
  if (Object.hasOwn(CODE_FILENAME_LANG, base)) return CODE_FILENAME_LANG[base];
  const ext = extOf(path);
  if (ext && Object.hasOwn(CODE_EXT_LANG, ext)) return CODE_EXT_LANG[ext];
  return null;
}

/** Disk-sourced code/config documents are eligible for code→PDF conversion. */
export function isConvertibleCode(item: SendItem): boolean {
  return item.type === 'document' && item.source.kind === 'disk' && detectCodeLang(item.source.path) !== null;
}

/** config.ts → config.ts.pdf (keep the full original name so .ts vs .json is
 *  visible to the receiver; two different files never collide on one .pdf). */
export function pdfNameForCode(path: string): string {
  return basenameOf(path) + '.pdf';
}

// --- Device presets -------------------------------------------------------
//
// Mobile page geometry. Width/height are CSS pt for the @page rule; Chrome's
// print-to-pdf honors @page size. iPhone 15 Pro logical resolution is
// 393×852 CSS px; we use a tall single page (the content flows, the PDF
// paginates as needed) at the phone width with comfortable margins.
export interface DevicePreset {
  // @page width in pt (1pt = 1px for Chrome print). Narrow = phone-readable.
  widthPt: number;
  // @page height in pt. Tall so a screenful of code is one page.
  heightPt: number;
  // page margin in pt.
  marginPt: number;
  // monospace font size in pt.
  fontPt: number;
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  // iPhone 15 / 15 Pro / 16 — 393pt logical width.
  iphone15pro: { widthPt: 393, heightPt: 852, marginPt: 14, fontPt: 12 },
  // Pro Max / Plus — 430pt logical width, a touch larger type.
  iphone15promax: { widthPt: 430, heightPt: 932, marginPt: 16, fontPt: 12.5 },
  // Older / SE — 375pt.
  iphonese: { widthPt: 375, heightPt: 667, marginPt: 12, fontPt: 11 },
  // Desktop / print fallback.
  a4: { widthPt: 595, heightPt: 842, marginPt: 36, fontPt: 11 },
};

export const DEFAULT_DEVICE = 'iphone15pro';

/**
 * Resolve a device name (CLI flag wins over env) to a preset; unknown → default.
 * `requested` echoes the raw value that was asked for (flag or env), so the
 * caller can name the actual bad value in a warning instead of 'undefined'.
 * `source` says where it came from ('flag' / 'env' / 'default') for the same
 * reason. `unknown` is true only when a value WAS provided but matched nothing.
 */
export function resolveDevice(
  flagDevice: string | undefined,
  env: Record<string, string | undefined>,
): { name: string; preset: DevicePreset; unknown: boolean; requested: string; source: 'flag' | 'env' | 'default' } {
  const raw = flagDevice ?? env.TG_PDF_DEVICE ?? DEFAULT_DEVICE;
  const source: 'flag' | 'env' | 'default' =
    flagDevice !== undefined ? 'flag' : env.TG_PDF_DEVICE !== undefined ? 'env' : 'default';
  const requested = raw.toLowerCase();
  // Object.hasOwn guards the prototype keys: `--pdf-device constructor` (or
  // toString/valueOf) must be "unknown", not resolve to a Function via the
  // prototype chain (which yields @page { size: undefinedpt … }).
  if (Object.hasOwn(DEVICE_PRESETS, requested)) {
    return { name: requested, preset: DEVICE_PRESETS[requested], unknown: false, requested: raw, source };
  }
  return { name: DEFAULT_DEVICE, preset: DEVICE_PRESETS[DEFAULT_DEVICE], unknown: true, requested: raw, source };
}

// --- CSS ------------------------------------------------------------------
//
// Mobile, monospace, syntax-highlighted, SOFT-WRAPPED. The two wrap rules
// (white-space: pre-wrap + overflow-wrap: anywhere) are the critical bit —
// without them Chrome lets <pre> scroll horizontally and the right edge of
// every long line is lost off-screen on a phone. word-break keeps very long
// unbroken tokens (URLs, base64, minified) from blowing the page width too.
export function codeCss(preset: DevicePreset, lineNumbers: boolean): string {
  return `
@page { size: ${preset.widthPt}pt ${preset.heightPt}pt; margin: ${preset.marginPt}pt; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body { color: #1a1a1a; max-width: none; }
/* Hide pandoc's --standalone title block (a big serif H1 of the filename); the
   <title> metadata stays so pandoc emits no empty-title warning, but on the page
   we show only our compact code-meta header below. */
header#title-block-header { display: none; }
header.code-meta {
  font-family: -apple-system, "Helvetica Neue", "Segoe UI", sans-serif;
  font-size: ${(preset.fontPt - 1).toFixed(1)}pt;
  color: #555; border-bottom: 1px solid #ddd;
  padding-bottom: 4pt; margin-bottom: 8pt; word-break: break-all;
}
pre, code {
  font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  font-size: ${preset.fontPt}pt;
  line-height: 1.5;
}
pre {
  background: #f7f7f8;
  border: 1px solid #ececef;
  border-radius: 5pt;
  padding: 8pt;
  margin: 0;
  /* THE critical wrap rules — no horizontal scroll on a phone. */
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
/* Skylighting wraps each token in <span class="..."> inside <pre><code>. */
pre code { background: none; border: 0; padding: 0; }
${
  lineNumbers
    ? `
/* Pandoc's --standalone stylesheet already draws the line-number gutter
   (pre.numberSource, CSS counter on each line's leading <a>). We only nudge the
   gutter color + divider; the counter mechanism itself is pandoc's. */
pre.numberSource { margin-left: 2.6em; border-left: 1px solid #e3e3e6; padding-left: 4pt; }
pre.numberSource code > span > a:first-child::before { color: #b0b0b0; }`
    : ''
}
`;
}

// --- Conversion -----------------------------------------------------------

export interface CodeConvertOptions {
  // pandoc highlight style (skylighting). Light theme for readability on a
  // phone in daylight. Overridable via TG_PDF_THEME.
  highlightStyle?: string;
  // show line numbers in the gutter.
  lineNumbers?: boolean;
}

// Fence the content so pandoc treats it as a single code block in `lang`. Use a
// run of backticks longer than any run inside the content so embedded fences
// (a .md-ish snippet, a here-doc) can't terminate ours early. Pandoc's
// ATTRIBUTE fence form `{.lang}` (and `{.lang .numberLines}` for the gutter) is
// used — that form requires the `markdown` reader (NOT `gfm`, which treats the
// braces literally), so convertCodeToPdf invokes pandoc with `-f markdown`.
// Skylighting highlights `.lang`; `.numberLines` makes pandoc emit a
// CSS-counter line-number gutter (its own --standalone stylesheet styles it).
export function fenceContent(content: string, lang: string, lineNumbers = false): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const classes = lineNumbers ? `.${lang} .numberLines` : `.${lang}`;
  // A trailing newline before the closing fence guarantees it sits on its own
  // line even when the file has no final newline.
  const body = content.endsWith('\n') ? content : content + '\n';
  return `${fence}{${classes}}\n${body}${fence}\n`;
}

/**
 * Convert one on-disk code/config file to a mobile, syntax-highlighted PDF in a
 * private temp dir. Returns the PDF path on success; otherwise an error string
 * (the caller warns and keeps the original attachment).
 *
 * Reuses findChrome + fileUrl from the md-pdf module; the only new pieces are
 * type detection, the fenced-markdown wrapping, and the mobile CSS.
 */
export function convertCodeToPdf(
  codePath: string,
  deps: ConvertDeps,
  preset: DevicePreset,
  options: CodeConvertOptions = {},
): ConvertOutcome {
  const lang = detectCodeLang(codePath);
  if (!lang) return { pdfPath: null, error: 'not a recognized code/config type', tmpDir: null };

  const chrome = findChrome(deps);
  if (!chrome) return { pdfPath: null, error: 'Chrome not found (set TG_CHROME_PATH)', tmpDir: null };

  let content: string;
  try {
    content = deps.readFile(codePath);
  } catch {
    return { pdfPath: null, error: 'could not read file', tmpDir: null };
  }

  const tmp = deps.makeTempDir();
  const fail = (error: string): ConvertOutcome => ({ pdfPath: null, error, tmpDir: tmp });
  const cssPath = `${tmp}/style.css`;
  const mdPath = `${tmp}/code.md`; // ASCII name; the file:// URL is encoded anyway
  const htmlPath = `${tmp}/doc.html`;
  const pdfPath = `${tmp}/${pdfNameForCode(codePath)}`;

  const lineNumbers = options.lineNumbers ?? false;
  deps.writeFile(cssPath, codeCss(preset, lineNumbers));

  // A tiny header line naming the file, then the fenced code block. The header
  // is plain markdown so it rides through pandoc and renders above the code.
  const base = basenameOf(codePath);
  const markdown =
    `<header class="code-meta">${escapeHtmlText(base)}</header>\n\n` + fenceContent(content, lang, lineNumbers);
  deps.writeFile(mdPath, markdown);

  const highlightStyle = options.highlightStyle ?? deps.env.TG_PDF_THEME ?? 'tango';
  // `-f markdown` (NOT gfm): pandoc's own reader honors the `{.lang .numberLines}`
  // attribute fence emitted by fenceContent; gfm would render the braces
  // literally as a class name, killing both highlighting and line numbers.
  const pandocArgs = [
    'pandoc',
    '-f',
    'markdown',
    '-t',
    'html5',
    '--standalone',
    '--highlight-style',
    highlightStyle,
    '--metadata',
    `title=${base}`,
    '--css',
    cssPath,
    '-o',
    htmlPath,
    mdPath,
  ];

  const pandoc = deps.run(pandocArgs, 10_000);
  if (pandoc === null) return fail('pandoc not found (brew install pandoc)');
  if (pandoc.exitCode !== 0) {
    return fail(`pandoc failed: ${pandoc.stderr.trim().slice(0, 200)}`);
  }

  const chromeRun = deps.run(
    [
      chrome,
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      '--virtual-time-budget=2000',
      `--print-to-pdf=${pdfPath}`,
      fileUrl(htmlPath),
    ],
    30_000,
  );
  if (chromeRun === null || chromeRun.exitCode !== 0) {
    const detail = chromeRun ? chromeRun.stderr.trim().slice(0, 200) : 'spawn failed';
    return fail(`chrome print-to-pdf failed: ${detail}`);
  }
  if (deps.fileSize(pdfPath) <= 0) {
    return fail('chrome reported success but produced no/empty PDF');
  }
  return { pdfPath, error: null, tmpDir: tmp };
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Plan mutation (the default + flags, as pure logic) -------------------
//
// Encodes the exact attach decision so the entrypoint stays a thin wire and the
// behavior is unit-testable without spawning pandoc/Chrome:
//
//   default                : send ONLY the PDF (drop the original).
//   --with-original (true) : send the PDF AND the original.
//   conversion failure     : keep the original unchanged (and warn).
//
// `--no-pdf` is handled by the caller (it skips calling this entirely). Markdown
// and non-code documents are skipped here (isConvertibleCode → false), so they
// flow through untouched to the md-as-pdf pass / plain attach.
export interface CodePdfPlanResult {
  // The new document list (PDFs swapped in; originals re-added when requested).
  documents: SendItem[];
  // Temp dirs created for SUCCESSFUL renders — the caller removes them AFTER the
  // upload (the PDF inside is still being sent).
  tmpDirs: string[];
  // Temp dirs left by FAILED renders — the caller removes them IMMEDIATELY (no
  // artifact rides; leaving them leaks /tmp, e.g. on a box with Chrome but no
  // pandoc). Kept separate from tmpDirs because their lifetimes differ.
  failedTmpDirs: string[];
  // Per-file failures (original kept). The caller emits a stderr warning each.
  failures: { path: string; error: string }[];
}

export interface CodePdfRunner {
  // Convert a single code file to a PDF; the entrypoint wires the real
  // convertCodeToPdf(path, deps, preset). Returning pdfPath=null means failure
  // (the original is kept).
  convert: (codePath: string) => ConvertOutcome;
}

export function applyCodePdfToPlan(
  documents: SendItem[],
  runner: CodePdfRunner,
  opts: { withOriginal?: boolean } = {},
): CodePdfPlanResult {
  const out: SendItem[] = [];
  const originals: SendItem[] = [];
  const tmpDirs: string[] = [];
  const failedTmpDirs: string[] = [];
  const failures: { path: string; error: string }[] = [];

  for (const doc of documents) {
    if (!isConvertibleCode(doc) || doc.source.kind !== 'disk') {
      out.push(doc);
      continue;
    }
    const originalPath = doc.source.path;
    // Fail-open: a thrown exception (e.g. mkdtemp/writeFile failing on an
    // unwritable or full TMPDIR) must NOT abort the send — treat it exactly like
    // a returned conversion failure and keep the original attached.
    let outcome: ConvertOutcome;
    try {
      outcome = runner.convert(originalPath);
    } catch (e) {
      outcome = { pdfPath: null, error: e instanceof Error ? e.message : String(e), tmpDir: null };
    }
    const { pdfPath, error, tmpDir } = outcome;
    if (pdfPath) {
      out.push({ type: 'document', source: { kind: 'disk', path: pdfPath } });
      if (tmpDir) tmpDirs.push(tmpDir);
      // PDF-only by default; re-add the raw file only with --with-original.
      if (opts.withOriginal) {
        originals.push({ type: 'document', source: { kind: 'disk', path: originalPath } });
      }
    } else {
      // Conversion failed → keep the original attached unchanged, and surface
      // the (possibly created) temp dir so the caller can drop it now: nothing
      // from it rides, so holding it until after transmit would just leak /tmp.
      out.push(doc);
      if (tmpDir) failedTmpDirs.push(tmpDir);
      failures.push({ path: originalPath, error: error ?? 'unknown error' });
    }
  }

  // Originals (when kept) ride AFTER the PDFs in the document order.
  return { documents: [...out, ...originals], tmpDirs, failedTmpDirs, failures };
}

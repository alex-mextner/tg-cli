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
import { type ConvertDeps, type ConvertOutcome, findChrome, printToPdf } from '../md-pdf/convert';

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
  // NOTE: .html/.htm are deliberately NOT here. An attached .html is a
  // Telegram-subset HTML *report* meant to be RENDERED (its <b>/<table>/<h1>
  // become real formatting), not source code to syntax-highlight. Fencing it as
  // code printed the literal tags verbatim in the PDF (issue #95). HTML takes
  // the convertHtmlToPdf render path; see HTML_RENDER_EXTENSIONS below.
  xml: 'xml',
  svg: 'xml',
  // .vue stays code: it is a component SOURCE file (template + script), read as
  // code on a phone — not a rendered report.
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

// Extensions that are RENDERED to a formatted PDF (HTML→DOM→PDF) rather than
// fenced as syntax-highlighted source. An attached .html/.htm is a
// Telegram-subset HTML report whose tags must become real formatting (issue
// #95), not literal text.
export const HTML_RENDER_EXTENSIONS = new Set(['html', 'htm']);

/** True for a disk-sourced .html/.htm document — rendered, not fenced as code. */
export function isRenderableHtml(item: SendItem): boolean {
  return (
    item.type === 'document' && item.source.kind === 'disk' && HTML_RENDER_EXTENSIONS.has(extOf(item.source.path))
  );
}

/**
 * Disk-sourced documents eligible for the code-pdf plan pass: either a
 * code/config file (fenced + syntax-highlighted) OR an HTML report (rendered to
 * formatted PDF). convertCodeToPdf dispatches between the two by extension.
 */
export function isConvertibleCode(item: SendItem): boolean {
  if (item.type !== 'document' || item.source.kind !== 'disk') return false;
  return detectCodeLang(item.source.path) !== null || HTML_RENDER_EXTENSIONS.has(extOf(item.source.path));
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
 * Reuses findChrome + printToPdf from the md-pdf module; the only new pieces are
 * type detection, the fenced-markdown wrapping, and the mobile CSS.
 */
export function convertCodeToPdf(
  codePath: string,
  deps: ConvertDeps,
  preset: DevicePreset,
  options: CodeConvertOptions = {},
): ConvertOutcome {
  // .html/.htm are RENDERED (tags → formatting), not fenced as source (issue
  // #95). Dispatch here so the entrypoint + applyCodePdfToPlan stay one pass.
  // `options` (highlightStyle / lineNumbers) is intentionally NOT forwarded: it
  // is code-fence-only (syntax theme + a line-number gutter), meaningless for a
  // rendered HTML report. If a render-relevant option is ever added, thread it.
  if (HTML_RENDER_EXTENSIONS.has(extOf(codePath))) {
    return convertHtmlToPdf(codePath, deps, preset);
  }

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

  const printErr = printToPdf(deps, chrome, htmlPath, pdfPath);
  if (printErr) return fail(printErr);
  return { pdfPath, error: null, tmpDir: tmp };
}

// The headless-Chrome print step (with the DNS blackhole + empty-PDF check) is
// the shared `printToPdf` helper in ../md-pdf/convert — ONE source of the print
// sandbox flags for the md-pdf path AND both code-pdf paths, so they can't drift
// (issue #102). What is code-pdf-SPECIFIC and stays here: the executable surface
// the HTML-render path must remove BEFORE that print — `<script>`, inline `on*=`
// handlers, `<iframe>`/`<object>`/`<embed>`/`<svg>` — handled UPSTREAM by
// sanitizeReportHtml + stripEventHandlerAttrs (issue #95). The blackhole stops a
// remote FETCH; those two layers stop code from RUNNING. (The JS-off flag
// `--blink-settings=scriptEnabled=false` was tried and SILENTLY breaks the print
// — Chrome emits an empty PDF — so the strip is the JS mitigation, not a flag.)

// --- HTML report → rendered PDF (issue #95) -------------------------------
//
// An attached .html/.htm is a Telegram-subset HTML report. Its tags
// (<b>/<i>/<code>/<pre>/<h1>-<h6>/<ul>/<ol>/<li>/<table>/<blockquote>/…) must be
// RENDERED as formatting, not printed verbatim. pandoc `-f html -t html5`
// parses the HTML into a document AST and re-emits clean standalone HTML
// (<b>→<strong>, tables/headings/lists preserved); Chrome then prints it
// formatted. This is the opposite of the code-fence path, which wraps the file
// in a <pre><code> block and shows the source.
//
// The Telegram custom tags (<tg-emoji>/<tg-spoiler>/<tg-math>/…) are not known
// to a browser; they render as their text content, which is acceptable (and far
// better than the raw `<b>` the bug printed). The standard formatting tags —
// which is what the CTO's reports use — render correctly.

// Mobile, readable CSS for a rendered HTML report. Same phone @page geometry as
// the code path, but a proportional body font (it's prose, not source) with
// styled tables / blockquotes / code spans. Soft-wrap rules keep long code
// spans and URLs from forcing horizontal scroll on a phone.
export function htmlReportCss(preset: DevicePreset): string {
  return `
@page { size: ${preset.widthPt}pt ${preset.heightPt}pt; margin: ${preset.marginPt}pt; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body {
  color: #1a1a1a; max-width: none;
  font-family: -apple-system, "Helvetica Neue", "Segoe UI", sans-serif;
  font-size: ${preset.fontPt}pt; line-height: 1.5;
  overflow-wrap: anywhere; word-break: break-word;
}
header#title-block-header { display: none; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 0.8em 0 0.4em; }
h1 { font-size: ${(preset.fontPt + 5).toFixed(1)}pt; }
h2 { font-size: ${(preset.fontPt + 3).toFixed(1)}pt; }
h3 { font-size: ${(preset.fontPt + 1.5).toFixed(1)}pt; }
p { margin: 0.5em 0; }
code, pre {
  font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  font-size: ${(preset.fontPt - 0.5).toFixed(1)}pt;
}
code { background: #f2f2f4; border-radius: 3pt; padding: 0 2pt; }
pre {
  background: #f7f7f8; border: 1px solid #ececef; border-radius: 5pt;
  padding: 8pt; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
}
pre code { background: none; padding: 0; }
blockquote {
  border-left: 3pt solid #d0d0d4; margin: 0.6em 0; padding: 0.1em 0 0.1em 0.8em; color: #555;
}
ul, ol { margin: 0.5em 0; padding-left: 1.4em; }
li { margin: 0.2em 0; }
table { border-collapse: collapse; margin: 0.6em 0; width: 100%; }
th, td { border: 1px solid #d0d0d4; padding: 3pt 6pt; text-align: left; vertical-align: top; }
th { background: #f2f2f4; }
hr { border: 0; border-top: 1px solid #ddd; margin: 0.8em 0; }
a { color: #0a66c2; }
`;
}

// Sanitization is TWO layers, applied at the two points where each is safe to
// reason about. `tg --file x.html` accepts ANY disk .html, and pandoc's default
// raw_html extension preserves `<script>`, inline `on*=` handlers, and embed
// elements verbatim — which then RUN in the (--no-sandbox) Chrome print. This is
// a render of a STATIC report; none of that is ever legitimate, so it is removed:
//
//   LAYER 1 — sanitizeReportHtml, on the RAW report BEFORE pandoc: strip whole
//     executable/embed ELEMENT blocks (<script>/<style>/<iframe>/<object>/
//     <embed>/<link>/<meta>/<base>) including their content. An open-tag…close-tag
//     block scan handles a `>` inside an attribute value correctly (it scans to
//     the matching close tag, not the first `>`). <svg>/<math> are handled here
//     too: they are NOT in the Telegram report subset (so nothing legitimate is
//     lost), and they are the one place LAYER 2's html5-shaped regex can't be
//     trusted — pandoc may pass an <svg> subtree through as raw_html, where an
//     <svg onload=…>, a nested <svg><script>, or an external <use href="http://…">
//     would not be modeled by the start-tag tokenizer.
//     A WELL-FORMED <svg>…</svg>/<math>…</math> is removed whole (block pass). A
//     MALFORMED/UNCLOSED one (no clean </svg>) doesn't match the block pass, so the
//     open/close tags AND the svg/math child elements that can carry a handler or
//     an external ref (<use>/<image>/<animate*>/<set>/<foreignObject>) are also
//     stripped individually — so an orphaned <animate onbegin=…> / <use href=…>
//     can't survive LAYER 1 into pandoc's raw passthrough. Residual: a benign
//     leftover like a stray <circle> text node is harmless; any handler pandoc DOES
//     normalize is still caught by LAYER 2, and remote refs by the DNS blackhole.
//
//   LAYER 2 — stripEventHandlerAttrs, on pandoc's OUTPUT (see convertHtmlToPdf):
//     remove `on*=` event handlers (onerror/onload/onclick/…). This MUST run on
//     pandoc's output, not the raw input: a raw-HTML tag matcher that stops at the
//     first `>` is defeated by `<img alt=">" src="x" onerror="beacon()">` — the
//     `>` inside the quoted `alt` ends the match early and the trailing `onerror`
//     survives, and pandoc then re-parses the full tag and KEEPS the handler. On
//     pandoc's NORMALIZED html5 every attribute is double-quoted and any `>` in a
//     value is escaped to `&gt;`, so `[^>]*` is a sound tag boundary and the
//     handler strip is robust. Without this the `onerror` fires during the print
//     (the blackholed `src` is guaranteed to fail to load → onerror runs).
//
// The formatting tags the report needs (<b>/<i>/<code>/<h1>/<table>/<ul>/
// <blockquote>/…) are untouched. Defense-in-depth alongside the DNS blackhole:
// the blackhole stops a remote fetch; these two layers stop code from running.
//
// FIXED-POINT loop: a SINGLE replace pass is bypassable by overlap — removing an
// inner match can re-form an outer one (`<scr<script>ipt>` → `<script>`,
// `<<script>script>` → `<script>`). Repeating the strip until the string stops
// changing closes that nesting bypass. Each pass strictly shrinks the string
// until stable; the iteration cap only guards a pathological input.
export function sanitizeReportHtml(html: string): string {
  let prev = '';
  let cur = html;
  for (let i = 0; cur !== prev && i < 100; i++) {
    prev = cur;
    // This is a DEFENSE-IN-DEPTH pre-filter, NOT the security boundary, so the
    // residual CodeQL flags below is accepted: a `<script` with no closing `>`
    // can survive this regex pass, but it cannot reach an executable context —
    // pandoc RE-PARSES the HTML (a broken/partial tag is normalized or dropped),
    // LAYER 2 strips every `on*=` handler on that normalized output, and the DNS
    // blackhole blocks any remote fetch; the input is the user's OWN attached
    // report, not adversarial web input. A DOM-parser sanitizer (jsdom/DOMPurify)
    // is disproportionate for a CLI that already shells out to pandoc + Chrome.
    // codeql[js/incomplete-multi-character-sanitization]
    cur = cur
      // Element blocks whose CONTENT must go too (open-tag…close-tag, any case,
      // across newlines). [^] matches any char incl. newline (s-flag-free). The
      // block scan reaches the matching </tag>, so a `>` inside an attribute
      // value can't end it early.
      .replace(/<(script|style|iframe|object|embed|svg|math)\b[^]*?<\/\1\s*>/gi, '')
      // Void/standalone head-injection, leftover unmatched open tags, and the
      // svg/math child elements that can carry a handler or an external ref —
      // stripped individually so a MALFORMED/unclosed <svg>/<math> (which the
      // block pass above can't match) still can't leave an active child behind.
      .replace(
        /<\/?(script|style|iframe|object|embed|link|meta|base|svg|math|use|image|animate|animateTransform|animateMotion|animateColor|set|foreignObject)\b[^>]*>/gi,
        '',
      );
  }
  return cur;
}

// Remove `on*=` event-handler ATTRIBUTES from start-tags. Designed to run on
// pandoc's NORMALIZED html5 output (every attribute is `name="value"`, double-
// quoted, with any `>` inside a value escaped to `&gt;`), where `[^>]*` is a
// sound tag boundary — so it tokenizes attributes correctly instead of guessing,
// with no false positive on body text like `online=true` (text nodes are never
// matched) and no malformed-input bypass. Pure. See LAYER 2 above for why the
// raw report can't be the input here.
export function stripEventHandlerAttrs(html: string): string {
  // A start-tag: letter-led name, an attribute run up to the closing `>`, an
  // optional self-closing `/`. pandoc never emits a literal `>` inside a value.
  return html.replace(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)(\s*\/?)>/g, (whole, name, attrs, tail) => {
    if (!attrs) return whole;
    // Drop any attribute whose NAME is `on…` (the value is the double-quoted
    // string pandoc emits; `[^"]*` can't escape it because inner `"` is escaped).
    // `[\s/]` as the name boundary also catches the `<b/onmouseover=…>` form.
    const cleaned = attrs.replace(/([\s/])on[a-zA-Z]+\s*=\s*"[^"]*"/g, '$1');
    return `<${name}${cleaned}${tail}>`;
  });
}

/**
 * Render one on-disk .html/.htm report to a mobile, FORMATTED PDF in a private
 * temp dir. Unlike convertCodeToPdf's fence path, the HTML is parsed by pandoc
 * (-f html) and rendered as DOM, so the tags become real bold/headings/tables/
 * lists/blockquotes (issue #95) — never printed verbatim. Sanitized in two
 * layers: sanitizeReportHtml strips executable/embed ELEMENTS from the raw
 * report before pandoc, and stripEventHandlerAttrs removes `on*=` handlers from
 * pandoc's normalized output before the print (see the layer note above).
 * Returns the PDF path on success; otherwise an error string (the caller keeps
 * the original .html).
 */
export function convertHtmlToPdf(htmlSrcPath: string, deps: ConvertDeps, preset: DevicePreset): ConvertOutcome {
  const chrome = findChrome(deps);
  if (!chrome) return { pdfPath: null, error: 'Chrome not found (set TG_CHROME_PATH)', tmpDir: null };

  let content: string;
  try {
    content = deps.readFile(htmlSrcPath);
  } catch {
    return { pdfPath: null, error: 'could not read file', tmpDir: null };
  }

  const tmp = deps.makeTempDir();
  const fail = (error: string): ConvertOutcome => ({ pdfPath: null, error, tmpDir: tmp });
  const cssPath = `${tmp}/style.css`;
  const srcPath = `${tmp}/source.html`; // ASCII name; the file content is the report HTML
  const htmlPath = `${tmp}/doc.html`; // pandoc's rendered, standalone output
  const pdfPath = `${tmp}/${pdfNameForCode(htmlSrcPath)}`;

  deps.writeFile(cssPath, htmlReportCss(preset));
  // Sanitize BEFORE pandoc: strip scripts/embeds/event handlers so nothing
  // executable survives into the (--no-sandbox) Chrome print. Formatting tags
  // are kept. See sanitizeReportHtml.
  deps.writeFile(srcPath, sanitizeReportHtml(content));

  const base = basenameOf(htmlSrcPath);
  // `-f html -t html5`: pandoc PARSES the HTML into its document model and
  // re-emits standalone html5. This is what turns the report's tags into a
  // rendered DOM instead of escaped source text. --standalone wraps it with our
  // mobile CSS; the title metadata avoids pandoc's empty-title warning (the CSS
  // hides the title block on the page).
  //
  // DELIBERATELY NO `--embed-resources` / `--resource-path`. A `.html` REPORT is
  // text-formatting, not an image document — and embed-resources base64-inlines
  // ANY local file the HTML references (`<img src="../secret">` reads it into the
  // PDF that is then uploaded to Telegram), a local-file-disclosure surface this
  // render path's own threat model (the DNS blackhole for remote refs) exists to
  // avoid. The cost is that a relative LOCAL `<img>` shows broken; remote images
  // are blackholed anyway. Accepted: reports don't carry images. (The md-pdf path
  // was brought to the same no-embed-resources parity in issue #102.)
  const pandocArgs = [
    'pandoc',
    '-f',
    'html',
    '-t',
    'html5',
    '--standalone',
    '--metadata',
    `title=${base}`,
    '--css',
    cssPath,
    '-o',
    htmlPath,
    srcPath,
  ];

  const pandoc = deps.run(pandocArgs, 10_000);
  if (pandoc === null) return fail('pandoc not found (brew install pandoc)');
  if (pandoc.exitCode !== 0) {
    return fail(`pandoc failed: ${pandoc.stderr.trim().slice(0, 200)}`);
  }

  // LAYER 2: strip `on*=` handlers from pandoc's NORMALIZED output before the
  // print. pandoc preserves event-handler attributes on the elements it models
  // (<img>/<div>/<span>/<td>/…), and the raw-input strip in sanitizeReportHtml
  // can be bypassed by a `>` inside a quoted attribute value — so the authoritative
  // handler removal happens here, on the quoted/escaped html5 where the tag
  // boundary is sound. A failure to re-read/-write the rendered doc must not abort
  // the send; on any I/O error keep pandoc's output (the blackhole still applies).
  try {
    deps.writeFile(htmlPath, stripEventHandlerAttrs(deps.readFile(htmlPath)));
  } catch {
    // best-effort: fall back to pandoc's output unchanged.
  }

  const printErr = printToPdf(deps, chrome, htmlPath, pdfPath);
  if (printErr) return fail(printErr);
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

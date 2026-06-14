// md-as-pdf feature: attached Markdown documents are converted to PDF before
// upload, because Telegram's built-in text preview mangles non-ASCII (it
// guesses the encoding and guesses wrong) and renders no formatting anyway.
// Pipeline: pandoc (gfm → standalone html5, utf-8 meta included) → headless
// Chrome --print-to-pdf. Chrome uses the system font stack, so color emoji
// (Apple Color Emoji) and Cyrillic render natively — verified visually via
// sips rasterization during development.
//
// Scope: DISK-sourced *.md/*.markdown documents only. Memory-sourced items
// (R4 fragments, line-spec marker copies) keep their exact text content on
// purpose — a marker comment is invisible in a PDF, which would defeat it.
//
// Failure policy: any missing tool / non-zero exit / timeout leaves the
// original .md attached unchanged with a one-line stderr warning. Conversion
// must never block or fail a send.

import type { SendItem } from '../auto-attach/types';

export const MD_EXTENSIONS = new Set(['md', 'markdown']);

export const PDF_CSS = `
body { font-family: -apple-system, "Helvetica Neue", "Segoe UI", sans-serif; max-width: 48em; margin: 2em auto; padding: 0 1em; }
code, pre { font-family: "SF Mono", Menlo, monospace; background: #f5f5f5; }
pre { padding: 0.8em; overflow-x: auto; }
table { border-collapse: collapse; }
td, th { border: 1px solid #ccc; padding: 4px 8px; }
blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #555; }
`;

// Chrome binary candidates, first existing wins. TG_CHROME_PATH overrides.
export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

// PATH command names probed after the absolute candidates (Linux installs
// often expose only these — codex review finding).
export const CHROME_PATH_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'];

function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Disk-sourced markdown documents are eligible for PDF conversion. */
export function isConvertibleMd(item: SendItem): boolean {
  return item.type === 'document' && item.source.kind === 'disk' && MD_EXTENSIONS.has(extOf(item.source.path));
}

/** report.md → report.pdf (keeps the meaningful basename for the receiver). */
export function pdfNameFor(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.(md|markdown)$/i, '') + '.pdf';
}

/** file:// URL with non-ASCII/space-safe percent-encoding (Chrome requires it). */
export function fileUrl(absPath: string): string {
  return 'file://' + absPath.split('/').map(encodeURIComponent).join('/');
}

export interface RunResult {
  exitCode: number;
  stderr: string;
}

export interface ConvertDeps {
  // Spawn a command, return exit code + stderr; null when the binary is missing.
  run: (cmd: string[], timeoutMs: number) => RunResult | null;
  // Create a fresh private temp dir and return its absolute path.
  makeTempDir: () => string;
  writeFile: (path: string, content: string) => void;
  // Read a UTF-8 file's content; throws on failure. Used by the code-pdf pass
  // (it fences the file content into a markdown code block); md-pdf itself never
  // calls this — pandoc reads the .md directly — but both share ConvertDeps.
  readFile: (path: string) => string;
  fileExists: (path: string) => boolean;
  // Size in bytes, or -1 when missing/unreadable (zero-byte PDF = failure).
  fileSize: (path: string) => number;
  // PATH lookup for a bare command name (Bun.which in production).
  whichCmd: (name: string) => string | null;
  env: Record<string, string | undefined>;
}

export interface ConvertOutcome {
  pdfPath: string | null;
  error: string | null;
  // Temp dir holding the html/css/pdf artifacts; the caller removes it after
  // the upload (or immediately on failure). Null when nothing was created.
  tmpDir: string | null;
}

/** Resolve the Chrome binary to use, or null when none is installed. */
export function findChrome(deps: Pick<ConvertDeps, 'fileExists' | 'whichCmd' | 'env'>): string | null {
  const override = deps.env.TG_CHROME_PATH;
  if (override) return deps.fileExists(override) ? override : null;
  for (const candidate of CHROME_CANDIDATES) {
    if (deps.fileExists(candidate)) return candidate;
  }
  for (const name of CHROME_PATH_NAMES) {
    const found = deps.whichCmd(name);
    if (found) return found;
  }
  return null;
}

/**
 * Convert one on-disk markdown file to a PDF in a private temp dir.
 * Returns the PDF path on success; otherwise an error string (the caller
 * warns and keeps the original attachment).
 */
export function convertMdToPdf(mdPath: string, deps: ConvertDeps): ConvertOutcome {
  const chrome = findChrome(deps);
  if (!chrome) return { pdfPath: null, error: 'Chrome not found (set TG_CHROME_PATH)', tmpDir: null };

  const tmp = deps.makeTempDir();
  const fail = (error: string): ConvertOutcome => ({ pdfPath: null, error, tmpDir: tmp });
  const cssPath = `${tmp}/style.css`;
  const htmlPath = `${tmp}/doc.html`; // ASCII name on purpose; the URL is encoded anyway
  const pdfPath = `${tmp}/${pdfNameFor(mdPath)}`;
  deps.writeFile(cssPath, PDF_CSS);

  const base = mdPath.slice(mdPath.lastIndexOf('/') + 1);
  const mdDir = mdPath.slice(0, mdPath.lastIndexOf('/')) || '/';
  const pandoc = deps.run(
    [
      'pandoc',
      '-f',
      'gfm',
      '-t',
      'html5',
      '--standalone',
      // Inline local images/assets as data URIs, resolved against the SOURCE
      // dir — the html lives in a temp dir, so relative `![x](img.png)` would
      // otherwise silently vanish from the PDF (codex review finding).
      '--embed-resources',
      '--resource-path',
      mdDir,
      '--metadata',
      `title=${base}`,
      '--css',
      cssPath,
      '-o',
      htmlPath,
      mdPath,
    ],
    10_000,
  );
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

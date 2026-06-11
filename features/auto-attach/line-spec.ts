// Line-spec orchestration (spec §Line-spec).
//
// This is the testable seam pulled out of the `tg` send path: given the merged
// attach items + an injected content reader, it decides, per line-spec DOCUMENT:
//   - the inline AST-aware ±2 snippet quote to splice below the path mention,
//   - the marker-injected in-memory copy that replaces the disk source on upload.
//
// A mentioned file is ALWAYS attached, regardless of size (decision C, 2026-06-11
// — "не помню чтобы я говорил что маленькие не прикладываем"; for paths the rule
// is "все аттачим да"). There is NO size gate. The earlier FIX-1 ≤1024 drop was
// an over-extrapolation of the R3 INLINE-EXCERPT rule (a pasted snippet ≤1024
// stays inline, not attached) onto path-referenced files — those are different:
// a path → attach, an inline excerpt → keep inline (R3 lives in extract.ts).
//
// Per item this layer only acts on line-spec text documents:
//   * Bare paths (no line-spec) and photos attach as-is via the normal send
//     path — nothing to plan here.
//   * Line-spec on a binary/unknown ext, or an unreadable file → no snippet, no
//     marker; the file attaches as-is (reading it as UTF-8 would corrupt it).
//
// All logic here is pure: disk reads come through the injected `readText`
// (returns null when the file is missing/binary/unreadable); nothing is written.

import { extractContextRange, injectMarkers, renderQuote } from './snippet';

export interface GateItem {
  type: 'photo' | 'document';
  path: string;
  // The trailing location spec, when the path was written as file.ts:N etc.
  lineSpec?: { token: string; startLine: number; endLine: number; col: number | undefined };
  // True only for auto-detected items (not explicit --photo/--file).
  auto?: true;
}

export interface QuoteRender {
  token: string;
  quote: string;
}

export interface MarkedSource {
  // The disk path whose attachment source should be replaced by the marker copy.
  path: string;
  filename: string;
  content: string;
}

export interface LineSpecPlan {
  // Inline snippet quotes to splice into the caption (line-spec items only).
  quotes: QuoteRender[];
  // Disk paths whose attachment source becomes a marker-injected in-memory copy.
  marked: MarkedSource[];
}

// Known text extensions — only these are snippet/marker-eligible AND char-size
// gateable. A binary document (e.g. report.pdf) reads as null via `readText`,
// so it never gets a snippet and is never char-gated (falls through to attach).
const TEXT_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'json',
  'jsonc',
  'md',
  'markdown',
  'sh',
  'bash',
  'zsh',
  'html',
  'css',
  'scss',
  'yaml',
  'yml',
  'go',
  'rs',
  'txt',
  'csv',
  'log',
  'toml',
  'ini',
  'xml',
  'sql',
  'rb',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'swift',
  'kt',
]);

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  return dot === -1 ? 'txt' : p.slice(dot + 1).toLowerCase();
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/**
 * Plan the line-spec snippets and marker copies for a set of attach items.
 * `readText(path)` returns the file's UTF-8 content, or null when the file is
 * missing / binary / unreadable (in which case no snippet/marker is produced and
 * the file attaches as-is). A mentioned file is ALWAYS attached regardless of
 * size (decision C) — there is no size gate here.
 */
export function planLineSpecs(items: GateItem[], readText: (path: string) => string | null): LineSpecPlan {
  const quotes: QuoteRender[] = [];
  const marked: MarkedSource[] = [];

  for (const it of items) {
    // Only line-spec documents get a snippet + marker copy. Photos and bare
    // paths attach as-is via the normal send path — nothing to plan here.
    if (it.type !== 'document' || !it.lineSpec) continue;

    const ext = extOf(it.path);
    // A line-spec on a binary/unknown ext: no snippet, no marker — attach the
    // file as-is (reading it as UTF-8 would corrupt the upload).
    if (!TEXT_EXTS.has(ext)) continue;
    const source = readText(it.path);
    // Unreadable despite a text ext → skip the snippet, attach as-is.
    if (source === null) continue;

    // Always show the ±2 snippet inline AND attach the marker-injected copy.
    // Small or large, the file is attached (decision C); the snippet is a
    // convenience preview, never a reason to drop the attachment.
    const ctx = extractContextRange(source, it.lineSpec.startLine, it.lineSpec.endLine, ext);
    quotes.push({ token: it.lineSpec.token, quote: renderQuote(ctx.text, ext) });
    marked.push({
      path: it.path,
      filename: baseName(it.path),
      content: injectMarkers(source, it.lineSpec.startLine, it.lineSpec.endLine, ext),
    });
  }

  return { quotes, marked };
}

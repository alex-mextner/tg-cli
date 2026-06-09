// Line-spec orchestration + the FIX 1 size gate (spec §Line-spec / §Size gate).
//
// This is the testable seam pulled out of the `tg` send path: given the merged
// attach items + an injected content reader, it decides, per DOCUMENT item:
//   - whether to render an inline AST-aware ±2 snippet quote (line-spec only),
//   - whether to swap the disk source for a marker-injected in-memory copy,
//   - whether to ATTACH the file at all (the size gate).
//
// FIX 1 — size gate (reconciles R1 "path → attach" with the 1024 principle):
//   * Line-spec path (file.ts:N): ALWAYS show the ±2 snippet inline. Attach the
//     FULL marker-injected file ONLY if its content > 1024 chars. If the whole
//     file ≤ 1024 → snippet inline ONLY, no attachment (the snippet already
//     shows everything).
//   * Bare path (no line-spec), AUTO-detected: attach ONLY if content > 1024
//     chars. If ≤ 1024 → do NOT attach; the path token stays in the text and
//     the content is NOT auto-inlined (decision A: don't dump unpasted content).
//   * EXPLICIT --photo/--file items are NEVER gated — a flag is a direct
//     instruction; they always attach (and are not auto-snippet'd).
//   * PHOTOS are never gated and never snippet'd — a char count on binary image
//     bytes is meaningless, and reading them as UTF-8 would corrupt the upload.
//   * UNREADABLE / non-text-ext documents fall through to ATTACH — when the size
//     can't be measured, err toward attaching, never silently drop a file.
//
// All logic here is pure: disk reads come through the injected `readText`
// (returns null when the file is missing/binary/unreadable); nothing is written.

import { extractContextRange, injectMarkers, renderQuote } from './snippet';
import { CAPTION_LIMIT } from './types';

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
  // Disk paths to DROP from the attachment list (gated out by the size rule).
  dropped: Set<string>;
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
 * Plan the line-spec snippets, marker copies, and size-gated drops for a set of
 * attach items. `readText(path)` returns the file's UTF-8 content, or null when
 * the file is missing / binary / unreadable (in which case the item is never
 * dropped — see header). `limit` defaults to the 1024 caption/size constant.
 */
export function planLineSpecs(
  items: GateItem[],
  readText: (path: string) => string | null,
  limit: number = CAPTION_LIMIT,
): LineSpecPlan {
  const quotes: QuoteRender[] = [];
  const marked: MarkedSource[] = [];
  const dropped = new Set<string>();

  for (const it of items) {
    // Photos: never gated, never snippet'd.
    if (it.type !== 'document') continue;

    const ext = extOf(it.path);
    const isTextExt = TEXT_EXTS.has(ext);

    if (it.lineSpec) {
      // A line-spec on a binary/unknown ext: no snippet, no char gate — attach
      // the file as-is (reading it as UTF-8 would corrupt the upload).
      if (!isTextExt) continue;
      const source = readText(it.path);
      // Unreadable despite a text ext → skip the snippet, attach as-is.
      if (source === null) continue;

      // The ±2 snippet is ALWAYS shown inline, regardless of file size.
      const ctx = extractContextRange(source, it.lineSpec.startLine, it.lineSpec.endLine, ext);
      quotes.push({ token: it.lineSpec.token, quote: renderQuote(ctx.text, ext) });

      // Size gate applies to AUTO-detected items only. An EXPLICIT --file with
      // an adopted line-spec (e.g. `--file x.ts "see x.ts:3"`) is a direct
      // instruction → always attach (with markers), never gated. An auto
      // line-spec file ≤ limit is fully visible in the snippet → no attachment.
      const gated = it.auto === true && source.length <= limit;
      if (gated) {
        dropped.add(it.path);
      } else {
        marked.push({
          path: it.path,
          filename: baseName(it.path),
          content: injectMarkers(source, it.lineSpec.startLine, it.lineSpec.endLine, ext),
        });
      }
      continue;
    }

    // Bare path (no line-spec). EXPLICIT items are never gated — always attach.
    if (!it.auto) continue;
    // Non-text / unreadable → can't measure chars → attach (never silently drop).
    if (!isTextExt) continue;
    const content = readText(it.path);
    if (content === null) continue;
    // Auto-detected bare doc: attach only when it exceeds the limit; otherwise
    // drop it (the path token stays in the text; content is NOT auto-inlined).
    if (content.length <= limit) dropped.add(it.path);
  }

  return { quotes, marked, dropped };
}

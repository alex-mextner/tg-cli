// Pure extraction logic for the auto-attach feature (spec §Architecture #1).
//
// No network, no disk writes. Everything here operates on strings and returns
// data the normalization layer turns into a SendPlan.
//
// Covers:
//   - R2: a detected file's FULL content pasted verbatim in the text → strip
//     that duplicated block (keep the path mention, the file is attached).
//   - R3/R4: fenced/free code blocks classified by size. ≤1024 stays inline
//     (R3); >1024 is extracted as a fragment file and removed from text (R4).
//   - filename inference for fragments (spec §C).
//   - language → extension detection.
//
// AST-awareness is deliberately LIGHT here (see snippet.ts for the line-spec
// extractor). Block detection is fence-based + content heuristics, which is
// honest about its limits — see comments and docs/specs/auto-attach.md.

export const EXCERPT_LIMIT = 1024;

export interface FileContent {
  path: string;
  content: string;
}

// Normalize for comparison: trim trailing whitespace per line + drop a trailing
// blank line, so a paste that differs only in a trailing newline still matches.
function normalizeForMatch(s: string): string {
  return s.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

/**
 * R2 — strip any block in `text` that is a verbatim paste of a detected file's
 * FULL content. Matching is whitespace-tolerant at line ends and on the
 * trailing newline. The path mention itself is never touched (only the pasted
 * body is removed); the file is attached separately by the caller.
 */
export function stripDuplicatedFileContent(text: string, files: FileContent[]): string {
  let out = text;
  for (const f of files) {
    const needleNorm = normalizeForMatch(f.content);
    if (!needleNorm || needleNorm.split('\n').length < 2) continue; // ignore trivial 1-liners
    const normOut = normalizeForMatch(out);
    const idx = normOut.indexOf(needleNorm);
    if (idx === -1) continue;
    // Map the match in the normalized string back onto the original by matching
    // line ranges (normalization only touches line-trailing whitespace, so line
    // counts are preserved). Find the block by lines.
    const needleLines = needleNorm.split('\n');
    const outLines = out.split('\n');
    const outNormLines = outLines.map((l) => l.replace(/[ \t]+$/, ''));
    for (let i = 0; i + needleLines.length <= outNormLines.length; i++) {
      let hit = true;
      for (let j = 0; j < needleLines.length; j++) {
        if (outNormLines[i + j] !== needleLines[j]) {
          hit = false;
          break;
        }
      }
      if (hit) {
        outLines.splice(i, needleLines.length);
        out = outLines.join('\n');
        break;
      }
    }
  }
  // Collapse the blank gap left behind (3+ newlines → 2).
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, (m) => (m.includes('\n\n') ? '\n' : ''));
}

export interface CodeBlock {
  lang: string; // detected/declared fence language (may be "")
  content: string; // the code inside the fence (no backticks)
  start: number; // index in the original text where the fenced block starts
  end: number; // index where it ends (exclusive) — text.slice(start,end) == full fence
}

/**
 * Find fenced code blocks (```lang ... ```) whose CONTENT exceeds EXCERPT_LIMIT
 * (R4 candidates). Small blocks (R3) are intentionally NOT returned — they stay
 * inline. Returns spans so the normalizer can excise the >1024 ones.
 */
export function extractLargeCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const fence = /```([a-zA-Z0-9+#._-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const content = m[2];
    if (content.length <= EXCERPT_LIMIT) continue; // R3 — leave inline
    blocks.push({
      lang: m[1] || '',
      content,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return blocks;
}

// Map a fence language token (or, failing that, content heuristics) to a file
// extension. Honest + small: covers the common langs the spec names; everything
// else degrades to .txt.
const LANG_EXT: Record<string, string> = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  py: 'py',
  python: 'py',
  json: 'json',
  md: 'md',
  markdown: 'md',
  sh: 'sh',
  bash: 'sh',
  shell: 'sh',
  html: 'html',
  css: 'css',
  yaml: 'yaml',
  yml: 'yaml',
  go: 'go',
  rust: 'rs',
  rs: 'rs',
};

export function detectLanguage(langToken: string, content: string): string {
  const tok = langToken.trim().toLowerCase();
  if (tok && LANG_EXT[tok]) return LANG_EXT[tok];
  if (tok) return tok.replace(/[^a-z0-9]/g, '') || 'txt';
  // Content heuristics (cheap, best-effort).
  const c = content.trim();
  if (!c) return 'txt';
  if (/^\s*[{[]/.test(c) && /[}\]]\s*$/.test(c)) {
    try {
      JSON.parse(c);
      return 'json';
    } catch {
      // not valid JSON — fall through
    }
  }
  if (/^\s*def\s+\w+\s*\(|^\s*import\s+\w+|:\s*$/m.test(c) && /:\n\s+/.test(c)) return 'py';
  if (/\bconst\b|\blet\b|=>|\bfunction\b|\bexport\b/.test(c)) return 'ts';
  if (/^#!/.test(c) || /\b(echo|export|fi|done)\b/.test(c)) return 'sh';
  return 'txt';
}

/**
 * Infer a fragment filename (spec §C). If a sentence ending in `:` immediately
 * precedes the excerpt, use its leading words as the base; otherwise a generic
 * "fragment". The extension comes from detectLanguage.
 */
export function inferFragmentName(precedingText: string, ext: string): string {
  const trimmed = precedingText.replace(/\s+$/, '');
  let base = 'fragment';
  const m = trimmed.match(/([^.\n!?:]*):\s*$/);
  if (m && m[1].trim()) {
    const words = m[1]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4);
    if (words.length) base = words.join('-');
  }
  return `${base}.${ext}`;
}

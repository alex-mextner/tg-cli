// --- Arg parsing (pure) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 0c, docs/specs/
// tg-decomposition.md). Pure: captures no main() state, all I/O reaches it via
// injected thunks (getWorktreeRoots / getFileIndex) or the real-fs helpers
// below. The entrypoint imports `parseArgs` + the `Format` type from here.
import { readdirSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { isNeverAttach } from '../auto-attach/denylist';
import { parseLineSpec } from '../auto-attach/snippet';
import { buildFileIndex, isRecursiveCandidate, matchFromIndex, type ListDir } from '../auto-attach/recursive';
import { looksPathLike, resolveAcrossWorktrees } from '../auto-attach/worktree';

export interface ItemLineSpec {
  // The full original token as written (e.g. "src/a.ts:42-50"), kept so the
  // quote can be anchored on it in the caption.
  token: string;
  startLine: number;
  endLine: number;
  col: number | undefined;
}

export interface Item {
  type: 'photo' | 'document';
  path: string;
  // Present only when the path was written with a trailing line-spec
  // (file.ts:42 / :42-50 / :42:5). Absent otherwise so no-spec parse results
  // are byte-identical to before (keeps existing toEqual assertions green).
  lineSpec?: ItemLineSpec;
  // True ONLY for items DETECTED by the auto-attach path scanner (not for
  // explicit --photo/--file). Marks auto-detected provenance (e.g. the
  // attach-denylist silently skips a denylisted AUTO path but hard-errors an
  // explicit one). Absent on explicit items so their existing toEqual
  // assertions stay byte-identical.
  auto?: true;
}

export type Format = 'plain' | 'html';

export type ParseResult =
  | { action: 'help' }
  | { action: 'version' }
  | { action: 'lsEmojiHelpers' }
  | { action: 'detectModel' }
  | { action: 'error'; message: string }
  | {
      action: 'send';
      items: Item[];
      caption: string;
      format: Format;
      // Explicit header title (`--title`). Appears on the `✳️ [window]` line as
      // `✳️ [window] <title>`. The message body is NEVER pulled up here.
      title?: string;
      // Explicit message tag (`--tag`). Rendered as an emoji badge before the
      // tag word: `✳️ [window] 🔵 💬 ОТВЕТ`. Composes with `--title`.
      tag?: string;
    };

// Extensions that Telegram's sendPhoto accepts. SVG is intentionally excluded:
// Telegram rejects SVG as a photo, so an auto-detected .svg path falls back to
// a document (explicit --photo still honors the user's choice).
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif']);

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// A "real" extension = a dot at basename position >0 with word chars after it.
// LICENSE, Makefile, tg → none; .env (dot at 0, nothing more) → none either.
// The auto-attach scanner skips extensionless files: they are usually
// code-adjacent artifacts the receiver can't preview, and dotfiles tend to
// hold secrets. Explicit --photo/--file remain a direct instruction.
export function hasRealExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /^.+\.[A-Za-z0-9]+$/.test(base);
}

export function expandHome(token: string, home: string): string {
  if (token === '~') return home;
  if (token.startsWith('~/')) return join(home, token.slice(2));
  return token;
}

/**
 * Resolve a text token to an existing file path, if it is one.
 * Tries ~-expansion, absolute, and cwd-relative resolution.
 * Returns the absolute path only when it resolves to a real file (not a dir).
 */
export function resolveExistingFile(token: string, cwd: string, home: string): string | null {
  if (!token) return null;
  const expanded = expandHome(token, home);
  const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch {
    // not a path / no access — treat as ordinary text
  }
  return null;
}

/**
 * Parse argv (already sliced past node/script) into an action. Never throws and
 * never calls process.exit: the caller decides what to do with the result.
 *
 * Precedence (the reconciliation point for "unknown dashed → error"):
 *   1. -h/--help and -v/--version win anywhere, before everything else.
 *   2. Info-only flags --ls-emoji-helpers / --detect-model win next.
 *   3. Real flags are matched: --format (with value validation), --photo,
 *      --file (each consuming a path value).
 *   4. ONLY a dashed token that matched none of the above is "unknown" → error.
 * This guarantees every flag main supports is recognized before the
 * unknown-dashed guard can fire, so none of them regress to an error.
 */
export function parseArgs(
  args: string[],
  cwd: string,
  home: string,
  autoAttach = true,
  // Worktree-aware fallback: a memoized thunk returning the priority-ordered
  // list of git worktree roots to probe when a path-like token fails plain
  // cwd/~/absolute resolution. Injected so tests stub it (and `main` memoizes
  // the real `enumerateWorktreeRoots`). Defaults to "no extra roots" — with the
  // thunk absent, resolution is exactly the old cwd-only behavior.
  getWorktreeRoots: () => string[] = () => [],
  // Never-attach denylist (feature `attach-denylist`, ON by default): secret-
  // looking files (.env family, private keys, credential rc-files, …) are
  // silently skipped by the auto-scan and a HARD ERROR for explicit flags.
  attachDenylist = true,
  // Recursive resolution (feature `recursive-attach`, ON by default): third
  // fallback after plain and worktree-root joins — search the worktree roots
  // (or cwd outside a git repo) recursively for the mentioned file (auto-attach
  // spec §Recursive resolution). The index thunk is injectable for tests;
  // the default builds one lazy real-fs index per parseArgs call.
  recursiveAttach = true,
  getFileIndex?: () => string[],
): ParseResult {
  // 1. Help / version win anywhere, before the empty check.
  for (const a of args) {
    if (a === '-h' || a === '--help') return { action: 'help' };
  }
  for (const a of args) {
    if (a === '-v' || a === '--version') return { action: 'version' };
  }

  // 2. Info-only flags win next, anywhere on the line.
  for (const a of args) {
    if (a === '--ls-emoji-helpers') return { action: 'lsEmojiHelpers' };
  }
  for (const a of args) {
    if (a === '--detect-model') return { action: 'detectModel' };
  }

  const explicit: Item[] = [];
  const textParts: string[] = [];
  let format: Format = 'plain';
  let title: string | undefined;
  let tag: string | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--format') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--format requires plain or html' };
      }
      if (nextArg !== 'plain' && nextArg !== 'html') {
        return {
          action: 'error',
          message: `unsupported format '${nextArg}'. Accepted values: plain, html`,
        };
      }
      format = nextArg;
      i += 2;
      continue;
    }
    if (arg === '--title') {
      const nextArg = args[i + 1];
      // Require a value; a dashed next token is treated as a missing value
      // (consistent with --format), so `--title --tag X` errors rather than
      // silently swallowing the next flag as the title.
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--title requires a value' };
      }
      title = nextArg;
      i += 2;
      continue;
    }
    if (arg === '--tag') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        return { action: 'error', message: '--tag requires a value' };
      }
      tag = nextArg;
      i += 2;
      continue;
    }
    if (arg === '--photo' || arg === '--file') {
      const nextArg = args[i + 1];
      // A dashed next token is only consumed as a path when it actually
      // resolves to an existing file (e.g. `--file -receipt.png`). Otherwise
      // it is a missing/invalid path → error, matching main's behavior.
      const dashedButNotAFile =
        !!nextArg && nextArg.startsWith('-') && resolveExistingFile(nextArg, cwd, home) === null;
      if (!nextArg || dashedButNotAFile) {
        return { action: 'error', message: `${arg} requires a file path argument` };
      }
      if (attachDenylist && isNeverAttach(nextArg)) {
        return {
          action: 'error',
          message:
            `refusing to attach '${nextArg}': matches the never-attach denylist (secrets). ` +
            'Override with --no-feature attach-denylist',
        };
      }
      explicit.push({ type: arg === '--photo' ? 'photo' : 'document', path: nextArg });
      i += 2;
      continue;
    }
    // A standalone dashed token that matched no known flag (and is not a flag
    // value, since those are consumed above) is an unknown flag → error.
    if (arg.startsWith('-')) {
      return { action: 'error', message: `unknown flag: ${arg}` };
    }
    // Anything else is plain text.
    textParts.push(arg);
    i += 1;
  }

  // Auto-detect existing-file paths in the message text. Split the joined text
  // on whitespace so both `tg /tmp/x.png` and `tg "look /tmp/x.png"` work.
  const explicitResolved = new Set(
    explicit.map((it) => resolveExistingFile(it.path, cwd, home)).filter((p): p is string => p !== null),
  );
  const autoItems: Item[] = [];
  // CORE CORRECTION (spec §"never excise a path"): a path mentioned in the text
  // STAYS in the text verbatim. We only DETECT it and attach the file — we never
  // strip the token from the caption. (The old behavior excised it; that is now
  // reversed.) Tokenize purely to find file references; the caption is the
  // original joined text, untouched except for outer-edge trimming.
  //
  // Auto-detection is the `auto-attach` FEATURE. When it is OFF, we skip the
  // scan entirely — only explicit --photo/--file are attached, and any path in
  // the text stays as plain words (it is never attached).
  if (autoAttach) {
    // Worktree-aware resolution (CTO request): when a token fails the plain
    // cwd/~/absolute resolve, AND it looks path-like, fall back to probing the
    // git worktree roots in priority order (current → main → branch-matched →
    // rest). `getWorktreeRoots` is the injected, memoized thunk; the path-like
    // gate keeps git OUT of the hot path for ordinary prose. This only changes
    // WHERE a relative path resolves — never the R1–R4 attach rules.
    const fileExistsAbs = (p: string): boolean => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    };
    // Recursive index (feature `recursive-attach`): built lazily, at most once
    // per parseArgs call, and ONLY when some token actually reaches the third
    // fallback — ordinary sends never pay for a tree walk.
    const realListDir: ListDir = (abs) => {
      try {
        return readdirSync(abs, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isFile: d.isFile(),
          isDirectory: d.isDirectory(),
        }));
      } catch {
        return null;
      }
    };
    let fileIndexCache: string[] | null = null;
    const getIndex =
      getFileIndex ??
      ((): string[] => {
        if (fileIndexCache === null) {
          const roots = getWorktreeRoots();
          fileIndexCache = buildFileIndex(roots.length > 0 ? roots : [cwd], realListDir);
        }
        return fileIndexCache;
      });
    const resolveWithWorktrees = (token: string): string | null => {
      const plain = resolveExistingFile(token, cwd, home);
      if (plain) return plain;
      if (!looksPathLike(token)) return null;
      const roots = getWorktreeRoots();
      if (roots.length > 0) {
        const fromWorktrees = resolveAcrossWorktrees(token, roots, fileExistsAbs);
        if (fromWorktrees) return fromWorktrees;
      }
      // Third fallback: recursive search (auto-attach spec §Recursive
      // resolution). The hit is re-checked against the real fs — the index
      // may be stale within a long-running process.
      if (recursiveAttach && isRecursiveCandidate(token)) {
        const hit = matchFromIndex(token, getIndex());
        if (hit && fileExistsAbs(hit)) return hit;
      }
      return null;
    };
    const segments = textParts.join(' ').split(/(\s+)/);
    for (let s = 0; s < segments.length; s++) {
      const isWhitespace = s % 2 === 1;
      const seg = segments[s];
      if (isWhitespace || !seg) continue;
      // First try a plain existing-file resolve. If that fails, the token may
      // carry a trailing line-spec (file.ts:42 / :42-50 / :42:5) — strip it and
      // resolve the base path. The full token stays in the caption either way.
      // Both resolves go through the worktree-aware fallback.
      let resolved = resolveWithWorktrees(seg);
      let spec: ItemLineSpec | undefined;
      if (!resolved) {
        const ls = parseLineSpec(seg);
        if (ls) {
          const baseResolved = resolveWithWorktrees(ls.path);
          if (baseResolved) {
            resolved = baseResolved;
            spec = {
              token: seg,
              startLine: ls.startLine,
              endLine: ls.endLine,
              col: ls.col,
            };
          }
        }
      }
      if (!resolved) continue;
      // Extensionless gate: an auto-DETECTED file without a real extension is
      // never attached (the token stays in the text as plain words).
      if (!hasRealExtension(resolved)) continue;
      // Never-attach denylist: a secret-looking file mentioned in the text is
      // never attached (the token stays as plain words).
      if (attachDenylist && isNeverAttach(resolved)) continue;
      if (explicitResolved.has(resolved)) {
        // Already attached (explicit --file/--photo or an earlier mention). Don't
        // attach twice, but if THIS mention carried a line-spec and the existing
        // item has none, adopt it so `--file x.ts "see x.ts:42"` still renders a
        // quote. First spec per file wins (a second, different spec is ignored —
        // documented in docs/specs/auto-attach.md; the marker copy can only mark
        // one range). Match on the resolved path, not the raw arg string.
        if (spec) {
          // Re-resolve via the SAME worktree-aware path so a cross-worktree
          // file (whose plain resolve is null) still matches its existing item.
          const existing = [...explicit, ...autoItems].find(
            (it) => resolveWithWorktrees(it.path) === resolved && !it.lineSpec,
          );
          if (existing) existing.lineSpec = spec;
        }
        continue;
      }
      explicitResolved.add(resolved); // dedup repeats within the text too
      const item: Item = { type: isImagePath(resolved) ? 'photo' : 'document', path: resolved, auto: true };
      if (spec) item.lineSpec = spec;
      autoItems.push(item);
    }
  }

  const items = [...explicit, ...autoItems];
  // Trim only the outer edges; interior formatting (newlines, alignment) stays.
  // The path token is intentionally KEPT in the caption (core correction).
  const caption = textParts.join(' ').replace(/^\s+|\s+$/g, '');

  // Empty invocation (or nothing left after path excision) → help, exit 0.
  // A bare `--title`/`--tag` still sends (a header-only message), so it is NOT
  // an empty invocation.
  if (items.length === 0 && !caption && !title && !tag) return { action: 'help' };
  return { action: 'send', items, caption, format, title, tag };
}

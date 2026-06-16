// --- Terminal color for `tg --help` / `tg --format-help` ---
//
// tg's help was the only ecosystem CLI whose --help printed flat, uncolored
// (review/rig/draw all colorize). This module brings tg in line with them using
// the SAME minimal ANSI scheme as rig (riglib/cli.py `_c`): raw `\033[CODEm…`
// escapes, no dependency, auto-disabled when output is not a TTY or NO_COLOR is
// set. It does NOT change the help TEXT — it post-processes a finished help
// string, so the plain content (and every substring test against it) is intact
// when color is off.
//
// Scheme (matches rig/review/draw): section headers (a line ending in `:`) =
// bold cyan, long/short option names (`--flag` / `-h`) at the start of an
// indented line = green. Everything else (usage example lines, descriptions,
// metavars) stays default.
//
// Exported so the tests assert against the SAME escape codes the renderer emits
// (no second copy to drift out of sync).
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const CYAN = '\x1b[36m';
export const GREEN = '\x1b[32m';

/**
 * Whether to emit color: only when writing to an interactive terminal and the
 * user has not opted out via NO_COLOR (https://no-color.org). A piped/redirected
 * `tg --help` (and every test subprocess) gets plain text.
 *
 * `stream` defaults to process.stdout; pass an explicit `isTTY` to test both
 * branches without a real terminal.
 */
export function shouldColorize(opts?: { isTTY?: boolean; noColor?: boolean }): boolean {
  const isTTY = opts?.isTTY ?? Boolean(process.stdout.isTTY);
  const noColor = opts?.noColor ?? (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '');
  return isTTY && !noColor;
}

// A help-section HEADER line: a non-indented word(s) ending in ':' on its own
// line, e.g. "Usage:", "Options:", "Formats:", "Auto-attach (feature, …):".
// Indented continuation lines (option help text) never match — they start with
// spaces. Group 1 is the header up to and including the ':'; group 2 is any
// trailing whitespace, preserved verbatim so the plain text is byte-identical
// apart from the injected color codes.
const SECTION_HEADER = /^(\S[^\n]*:)(\s*)$/;

// The leading flag run of an indented help line: the comma-separated `--flag` /
// `-x` tokens at the very start, e.g. "--format" in "  --format plain|html  …"
// or "-v, --version" in "  -v, --version  …". We color ONLY this run — a metavar
// (`plain|html`, `<path>`) or the description that follows stays plain. The
// trailing `(?![\w-])` stops the match at the flag's end so a following metavar
// word isn't swallowed.
const OPTION_LEAD = /^(\s+)((?:-{1,2}[A-Za-z][\w-]*)(?:,\s+-{1,2}[A-Za-z][\w-]*)*)(?![\w-])/;

/**
 * Colorize a finished help/usage string for terminal display. Pure: returns the
 * input unchanged when `enabled` is false (the default decision comes from
 * shouldColorize). Operates line-by-line so it never colors inside a word.
 */
export function colorizeHelp(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return text
    .split('\n')
    .map((line) => {
      const header = line.match(SECTION_HEADER);
      if (header) return `${BOLD}${CYAN}${header[1]}${RESET}${header[2]}`;
      const opt = line.match(OPTION_LEAD);
      if (opt) {
        const [, indent, flags] = opt;
        const rest = line.slice(indent.length + flags.length);
        return `${indent}${GREEN}${flags}${RESET}${rest}`;
      }
      return line;
    })
    .join('\n');
}

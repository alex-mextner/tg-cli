import { expect, test } from 'bun:test';
// Import the ANSI constants from the module under test so the assertions can
// never drift from what the renderer actually emits.
import { colorizeHelp, shouldColorize, RESET, BOLD, CYAN, GREEN } from '../features/render/help-color';
import { USAGE } from '../tg';
import { formatHelp } from '../features/render/format-help';

// --- colorizeHelp is a no-op when disabled (the plain-text contract) ---
test('colorizeHelp returns the input unchanged when color is disabled', () => {
  expect(colorizeHelp(USAGE, false)).toBe(USAGE);
  expect(colorizeHelp(formatHelp(), false)).toBe(formatHelp());
  expect(colorizeHelp('Options:\n  --foo  bar', false)).toBe('Options:\n  --foo  bar');
});

// --- Section headers (a non-indented line ending in ':') → bold cyan ---
test('colorizeHelp paints section headers bold cyan', () => {
  const out = colorizeHelp('Usage:\n  tg "x"\nOptions:\n  --foo  bar', true);
  expect(out).toContain(`${BOLD}${CYAN}Usage:${RESET}`);
  expect(out).toContain(`${BOLD}${CYAN}Options:${RESET}`);
});

// --- Option names (leading --flag / -x run of an indented line) → green ---
test('colorizeHelp paints the leading option flags green, leaves the description plain', () => {
  const out = colorizeHelp('Options:\n  --format plain|html  message format', true);
  expect(out).toContain(`${GREEN}--format${RESET}`);
  // The description text stays uncolored.
  expect(out).toContain('message format');
});

test('colorizeHelp colors a short+long flag pair (e.g. "-v, --version")', () => {
  const out = colorizeHelp('Options:\n  -v, --version  print version', true);
  expect(out).toContain(`${GREEN}-v, --version${RESET}`);
});

// --- Applied to the REAL help strings ---
test('colorizeHelp colors the real USAGE: headers + the documented flags', () => {
  const out = colorizeHelp(USAGE, true);
  expect(out).toContain(`${BOLD}${CYAN}Usage:${RESET}`);
  expect(out).toContain(`${BOLD}${CYAN}Options:${RESET}`);
  expect(out).toContain(`${GREEN}--format`);
  expect(out).toContain(`${GREEN}-h, --help${RESET}`);
  expect(out).toMatch(/\x1b\[32m--tag/);
  // It is genuinely colored (contains at least one ANSI escape).
  expect(out).toContain('\x1b[');
  // The plain content survives (option names still grep-able after coloring).
  expect(out).toContain('--reply-to');
  expect(out).toContain('--format-help');
});

test('colorizeHelp colors the real format-help reference: a header + an option flag', () => {
  const out = colorizeHelp(formatHelp(), true);
  // At least one section header (a line ending in ':') is wrapped bold-cyan.
  // Find a colored header by its literal BOLD+CYAN prefix + a RESET later on the
  // same line; we don't hardcode the header text (format-help wording can shift).
  const headerStart = `${BOLD}${CYAN}`;
  const coloredHeader = out.split('\n').find((line) => line.startsWith(headerStart) && line.includes(`:${RESET}`));
  expect(coloredHeader).toBeDefined();
  // The --tag / --reply-to / --title options are green.
  expect(out).toMatch(/\x1b\[32m--(tag|reply-to|title)/);
  // The plain content survives.
  expect(out).toContain('--format html');
});

// --- color is ONLY injected codes: stripping the ANSI escapes yields the input ---
test('colorizeHelp changes nothing but the color codes (strip → identical)', () => {
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  for (const src of [USAGE, formatHelp()]) {
    expect(stripAnsi(colorizeHelp(src, true))).toBe(src);
  }
});

// --- shouldColorize honors NO_COLOR + the TTY check (no real terminal needed) ---
test('shouldColorize: on when TTY and NO_COLOR unset; off otherwise', () => {
  expect(shouldColorize({ isTTY: true, noColor: false })).toBe(true);
  expect(shouldColorize({ isTTY: false, noColor: false })).toBe(false); // piped → plain
  expect(shouldColorize({ isTTY: true, noColor: true })).toBe(false); // NO_COLOR opt-out
  expect(shouldColorize({ isTTY: false, noColor: true })).toBe(false);
});

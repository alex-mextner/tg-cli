import { expect, test } from 'bun:test';
import { parseWindowPanes, resolveWindowPanes } from '../features/replies/window';

// `tmux list-panes -a -F "#{pane_id}\t#{window_name}"` output. pane_id is FIRST
// and TAB-delimited precisely so a window name with spaces (`ext: diagram`)
// survives the split — a space/name-first format would corrupt it.
const LINES = ['%0\text', '%3\text: diagram', '%5\text', '%9\tmain'].join('\n') + '\n';

test('parseWindowPanes: exact match unions duplicate window names across sessions', () => {
  // Two windows are literally named `ext` (%0 and %5); `ext: diagram` and `main`
  // must NOT be swept in.
  expect(parseWindowPanes(LINES, 'ext')).toEqual(['%0', '%5']);
});

test('parseWindowPanes: exact NOT prefix — `ext` never matches `ext: diagram`', () => {
  expect(parseWindowPanes(LINES, 'ext')).not.toContain('%3');
});

test('parseWindowPanes: a window name containing spaces is matched verbatim', () => {
  expect(parseWindowPanes(LINES, 'ext: diagram')).toEqual(['%3']);
});

test('parseWindowPanes: plain single match', () => {
  expect(parseWindowPanes(LINES, 'main')).toEqual(['%9']);
});

test('parseWindowPanes: no such window → empty array', () => {
  expect(parseWindowPanes(LINES, 'nope')).toEqual([]);
});

test('parseWindowPanes: empty output → empty array', () => {
  expect(parseWindowPanes('', 'ext')).toEqual([]);
});

test('parseWindowPanes: a line without a TAB is skipped (malformed)', () => {
  const out = parseWindowPanes('%7noTabHere\n%8\tok\n', 'ok');
  expect(out).toEqual(['%8']);
});

test('parseWindowPanes: only the FIRST tab splits pane id from name', () => {
  // A pathological window name that itself contains a tab keeps the tab in the
  // name (pane id is column 0, everything after the first tab is the name).
  expect(parseWindowPanes('%2\tweird\tname\n', 'weird\tname')).toEqual(['%2']);
});

// resolveWindowPanes — the I/O wrapper; the runner is injected so tmux-error /
// not-in-tmux handling is testable without a real tmux server.

test('resolveWindowPanes: tmux binary missing (run→null) → empty (no throw)', () => {
  expect(resolveWindowPanes('ext', () => null)).toEqual([]);
});

test('resolveWindowPanes: tmux non-zero exit (no server / not in tmux) → empty', () => {
  expect(resolveWindowPanes('ext', () => ({ exitCode: 1, stdout: '' }))).toEqual([]);
});

test('resolveWindowPanes: exit 0 → parses stdout through parseWindowPanes', () => {
  expect(resolveWindowPanes('ext', () => ({ exitCode: 0, stdout: LINES }))).toEqual(['%0', '%5']);
});

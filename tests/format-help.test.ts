import { expect, test } from 'bun:test';
import { FORMAT_HELP, formatHelp } from '../features/render/format-help';

test('formatHelp returns the reference constant', () => {
  expect(formatHelp()).toBe(FORMAT_HELP);
});

test('lists the supported HTML tags with examples', () => {
  for (const tag of [
    '<b>',
    '<i>',
    '<u>',
    '<s>',
    '<code>',
    '<pre>',
    '<a href',
    '<blockquote',
    '<tg-emoji',
    'tg-spoiler',
  ]) {
    expect(FORMAT_HELP).toContain(tag);
  }
});

test('documents the four HTML entities and that no others exist', () => {
  expect(FORMAT_HELP).toContain('&lt;');
  expect(FORMAT_HELP).toContain('&gt;');
  expect(FORMAT_HELP).toContain('&amp;');
  expect(FORMAT_HELP).toContain('&quot;');
});

test('states what is NOT supported: tables and <br>', () => {
  expect(FORMAT_HELP).toContain('<table>');
  expect(FORMAT_HELP).toContain('<br>');
  expect(FORMAT_HELP).toMatch(/NO tables|no native HTML tables|has NO tables/i);
});

test('points at the <pre> table pattern and --table', () => {
  expect(FORMAT_HELP).toContain('<pre>');
  expect(FORMAT_HELP).toContain('--table');
});

test('documents the --tag/--title badge and --reply-to', () => {
  expect(FORMAT_HELP).toContain('--tag');
  expect(FORMAT_HELP).toContain('--title');
  expect(FORMAT_HELP).toContain('--reply-to');
});

test('notes the one-emoji rule for tg-emoji', () => {
  expect(FORMAT_HELP).toMatch(/EXACTLY ONE emoji|exactly one emoji|one emoji/i);
});

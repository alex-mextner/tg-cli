import { expect, test } from 'bun:test';
import {
  convertEntitiesToHtml,
  detectHtmlTags,
  escapeHtml,
  parseEmojiHelpers,
  parseModeFor,
} from '../features/render/html';
import { buildPrefix } from '../features/render/prefix';

// Focused unit tests for the render modules extracted from the `tg` entrypoint
// (decomposition Stage 1). These functions were previously only exercised
// end-to-end through main(); the contracts they guarantee are pinned here.

// --- escapeHtml ---
test('escapeHtml escapes &, <, > and does & first (no double-escape)', () => {
  expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  // & must be escaped before < / > so the inserted &lt; isn't re-escaped
  expect(escapeHtml('a<b')).toBe('a&lt;b');
});

// --- detectHtmlTags ---
test('detectHtmlTags matches known Telegram tags, case-insensitively', () => {
  expect(detectHtmlTags('<b>x</b>')).toBe(true);
  expect(detectHtmlTags('<TG-EMOJI emoji-id="1">x</TG-EMOJI>')).toBe(true);
  expect(detectHtmlTags("<a href='x'>y</a>")).toBe(true);
  expect(detectHtmlTags('<span class="tg-spoiler">x</span>')).toBe(true);
});

test('detectHtmlTags ignores non-tags and bare comparison operators', () => {
  expect(detectHtmlTags('plain text')).toBe(false);
  expect(detectHtmlTags('2 < 3 and 5 > 4')).toBe(false);
  expect(detectHtmlTags('<notatag>')).toBe(false);
});

// --- parseModeFor ---
test('parseModeFor: explicit html always wins, plain only upgrades on real tags', () => {
  expect(parseModeFor('html')).toBe('HTML');
  expect(parseModeFor('html', 'hi')).toBe('HTML');
  expect(parseModeFor('plain', '<b>x</b>')).toBe('HTML');
  expect(parseModeFor('plain', 'hi')).toBeUndefined();
  expect(parseModeFor('plain')).toBeUndefined();
});

// --- convertEntitiesToHtml ---
test('convertEntitiesToHtml wraps each entity in a <tg-emoji> tag at its offset', () => {
  const text = '👐 hi';
  const entities = [
    { type: 'custom_emoji' as const, offset: 0, length: 2, custom_emoji_id: '123' },
  ];
  expect(convertEntitiesToHtml(text, entities)).toBe(
    '<tg-emoji emoji-id="123">👐</tg-emoji> hi',
  );
});

test('convertEntitiesToHtml leaves gaps verbatim by default, escapes them when escape=true', () => {
  const text = 'a<b 👐';
  const entities = [
    { type: 'custom_emoji' as const, offset: 4, length: 2, custom_emoji_id: '9' },
  ];
  // escape=false: surrounding text is intentional HTML, kept verbatim
  expect(convertEntitiesToHtml(text, entities, false)).toBe(
    'a<b <tg-emoji emoji-id="9">👐</tg-emoji>',
  );
  // escape=true: gaps are escaped so literals can't break HTML parsing
  expect(convertEntitiesToHtml(text, entities, true)).toBe(
    'a&lt;b <tg-emoji emoji-id="9">👐</tg-emoji>',
  );
});

test('convertEntitiesToHtml sorts entities by offset before walking', () => {
  const text = 'AB';
  const entities = [
    { type: 'custom_emoji' as const, offset: 1, length: 1, custom_emoji_id: 'b' },
    { type: 'custom_emoji' as const, offset: 0, length: 1, custom_emoji_id: 'a' },
  ];
  expect(convertEntitiesToHtml(text, entities)).toBe(
    '<tg-emoji emoji-id="a">A</tg-emoji><tg-emoji emoji-id="b">B</tg-emoji>',
  );
});

// --- parseEmojiHelpers ---
test('parseEmojiHelpers substitutes an embeddable :helper: with a placeholder + entity', () => {
  const { text, entities } = parseEmojiHelpers(':codex: hi');
  expect(text).toBe('👐 hi'); // codex unicode placeholder
  expect(entities).toHaveLength(1);
  expect(entities[0].custom_emoji_id).toBe('5273797309195393626');
  expect(entities[0].offset).toBe(0);
  expect(entities[0].length).toBe('👐'.length);
});

test('parseEmojiHelpers maps a unicode-only helper to its char with no entity', () => {
  const { text, entities } = parseEmojiHelpers(':glm:');
  expect(text).toBe('🗂');
  expect(entities).toHaveLength(0);
});

test('parseEmojiHelpers leaves unknown :markers: untouched', () => {
  const { text, entities } = parseEmojiHelpers('say :zzznotahelper: now');
  expect(text).toBe('say :zzznotahelper: now');
  expect(entities).toHaveLength(0);
});

// --- buildPrefix ---
test('buildPrefix returns the empty/absent prefix when nothing to show', () => {
  expect(buildPrefix({ aiEmoji: '', model: '', tmuxWindow: '' })).toEqual({
    html: '',
    plain: '',
    present: false,
    forceHtml: false,
  });
});

test('buildPrefix renders a branded model as a <tg-emoji> tag and forces HTML', () => {
  const p = buildPrefix({ aiEmoji: '👐', model: 'codex', tmuxWindow: '' });
  expect(p.html).toBe('<tg-emoji emoji-id="5273797309195393626">👐</tg-emoji>\n');
  expect(p.plain).toBe('👐\n');
  expect(p.present).toBe(true);
  expect(p.forceHtml).toBe(true);
});

test('buildPrefix without a branded id keeps a plain (escaped) emoji, no forced HTML', () => {
  const p = buildPrefix({ aiEmoji: '🤖', model: 'no-such-model-xyz', tmuxWindow: '' });
  expect(p.html).toBe('🤖\n');
  expect(p.plain).toBe('🤖\n');
  expect(p.present).toBe(true);
  expect(p.forceHtml).toBe(false);
});

test('buildPrefix forces HTML for a Cyrillic window name (the <b> fallback)', () => {
  const p = buildPrefix({ aiEmoji: '', model: '', tmuxWindow: 'тест' });
  expect(p.present).toBe(true);
  expect(p.forceHtml).toBe(true);
  expect(p.html).toBe('[<b>тест</b>]\n');
  expect(p.plain).toBe('[тест]\n');
});

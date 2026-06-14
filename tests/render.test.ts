import { expect, test } from 'bun:test';
import {
  convertEntitiesToHtml,
  detectHtmlTags,
  escapeHtml,
  parseEmojiHelpers,
  parseModeFor,
} from '../features/render/html';
import { buildPrefix, splitForCells } from '../features/render/prefix';
import { TAG_PILL_IDS, TAG_PILL_PLACEHOLDER } from '../features/branding/emoji';

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
  const entities = [{ type: 'custom_emoji' as const, offset: 0, length: 2, custom_emoji_id: '123' }];
  expect(convertEntitiesToHtml(text, entities)).toBe('<tg-emoji emoji-id="123">👐</tg-emoji> hi');
});

test('convertEntitiesToHtml leaves gaps verbatim by default, escapes them when escape=true', () => {
  const text = 'a<b 👐';
  const entities = [{ type: 'custom_emoji' as const, offset: 4, length: 2, custom_emoji_id: '9' }];
  // escape=false: surrounding text is intentional HTML, kept verbatim
  expect(convertEntitiesToHtml(text, entities, false)).toBe('a<b <tg-emoji emoji-id="9">👐</tg-emoji>');
  // escape=true: gaps are escaped so literals can't break HTML parsing
  expect(convertEntitiesToHtml(text, entities, true)).toBe('a&lt;b <tg-emoji emoji-id="9">👐</tg-emoji>');
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

// REGRESSION (CTO 2026-06-14, reverting PR #18): the prefix ends with a NEWLINE,
// never a space — the message body sits BELOW the header line and is NEVER
// joined onto `✳️ [window]`. PR #18 changed the trailing "\n" to " " so the
// body's first line rode up onto the header; the CTO explicitly does NOT want
// the message text pulled up ("Текст сообщения не надо подтягивать").
test('buildPrefix ends the header with a newline so the body stays BELOW it', () => {
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli' });
  expect(p.html).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶]\n');
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶]\n');
  expect(p.plain.endsWith('\n')).toBe(true);
});

test('the message body is NOT pulled onto the header line', () => {
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli' });
  // renderText composes prefix + body (tg entrypoint). The newline join keeps
  // the body on line 2, never appended to `[window]`.
  const composed = p.plain + 'Handoff received, starting cleanup';
  const lines = composed.split('\n');
  expect(lines.length).toBe(2);
  expect(lines[0]).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶]'); // header alone, no body text
  expect(lines[1]).toBe('Handoff received, starting cleanup');
});

// --- buildPrefix: explicit --title (NEVER the message body) ---
test('buildPrefix --title puts the explicit title on the header line, body still below', () => {
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', title: 'Ship it' });
  // Title styled Bold Italic (same as the autolink ticket title); body below.
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 𝑺𝒉𝒊𝒑 𝒊𝒕\n');
  expect(p.html).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 𝑺𝒉𝒊𝒑 𝒊𝒕\n');
  expect(p.plain.endsWith('\n')).toBe(true);
});

test('buildPrefix --title with a Cyrillic title falls back to <i> and forces HTML', () => {
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', title: 'Готово' });
  expect(p.html).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] <i>Готово</i>\n');
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] Готово\n');
  expect(p.forceHtml).toBe(true);
});

// --- buildPrefix: explicit --tag badge ---
//
// Default repo state: TAG_PILL_IDS holds PLACEHOLDER ids, so EVERY known tag
// renders via the unicode fallback (`🔵 ANSWER`). A placeholder id must NEVER
// leak into a <tg-emoji>. The real-pill-ids path (N <tg-emoji> cells) is tested
// separately by swapping in real-looking ids and restoring them.

test('buildPrefix --tag (placeholder ids) renders the unicode fallback badge, body below', () => {
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'ANSWER' });
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 🔵 ANSWER\n');
  expect(p.html).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 🔵 ANSWER\n');
  // Guard: a placeholder must never be emitted inside a <tg-emoji> tag.
  expect(p.html).not.toContain('<tg-emoji');
  expect(p.html).not.toContain('PLACEHOLDER');
  expect(p.plain.endsWith('\n')).toBe(true);
});

test('buildPrefix --tag (Russian alias) resolves to the English canonical fallback', () => {
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'РЕШЕНИЕ' });
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 🟠 DECISION\n');
});

test('buildPrefix --tag (English alias, lowercase) resolves to the canonical fallback', () => {
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'decision' });
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 🟠 DECISION\n');
});

test('buildPrefix --tag + --title compose: badge, em-dash, then title', () => {
  const p = buildPrefix({
    aiEmoji: '✳️',
    model: 'no-brand',
    tmuxWindow: 'tg-cli',
    tag: 'ANSWER',
    title: 'Done',
  });
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 🔵 ANSWER — 𝑫𝒐𝒏𝒆\n');
});

test('buildPrefix unknown --tag soft-renders as a plain [TAG] badge (no hard fail)', () => {
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'wat' });
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] [WAT]\n');
  expect(p.html).not.toContain('<tg-emoji'); // unknown tag never emits a pill
  expect(p.present).toBe(true);
});

// Exact rendered header for each of the four canonical tags (unicode fallback,
// the default placeholder state).
test('buildPrefix: exact fallback header for each of the four canonical tags', () => {
  const win = '[𝘁𝗴-𝗰𝗹𝗶]';
  const mk = (tag: string): string =>
    buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag }).plain;
  expect(mk('ANSWER')).toBe(`✳️ ${win} 🔵 ANSWER\n`);
  expect(mk('DECISION')).toBe(`✳️ ${win} 🟠 DECISION\n`);
  expect(mk('PROBLEM')).toBe(`✳️ ${win} 🔴 PROBLEM\n`);
  expect(mk('REPORT')).toBe(`✳️ ${win} 🟢 REPORT\n`);
});

// --- buildPrefix: real pill ids → N <tg-emoji> cells (premium path) ---
// TAG_PILL_IDS is mutated in-place to real-looking ids (19-digit numerics),
// then restored, so the live renderer is exercised without a leaky module mock.
test('buildPrefix --tag with REAL pill ids renders N <tg-emoji> cells and forces HTML', () => {
  const realIds = ['5300000000000000001', '5300000000000000002'];
  const saved = TAG_PILL_IDS.ANSWER;
  TAG_PILL_IDS.ANSWER = [...realIds];
  try {
    const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'ANSWER' });
    // N cells (here 2). The fallback label "🔵 ANSWER" is SPLIT across the cells
    // (by code point) so the underlying text reads as the readable label once.
    expect(p.html).toBe(
      '✳️ [𝘁𝗴-𝗰𝗹𝗶] ' +
        `<tg-emoji emoji-id="${realIds[0]}">🔵 AN</tg-emoji>` +
        `<tg-emoji emoji-id="${realIds[1]}">SWER</tg-emoji>\n`,
    );
    // The concatenation of the cell inner texts === the full readable label.
    const innerTexts = [...p.html.matchAll(/<tg-emoji emoji-id="\d+">([^<]*)<\/tg-emoji>/g)].map((m) => m[1]);
    expect(innerTexts.join('')).toBe('🔵 ANSWER');
    // plain keeps the unicode fallback (non-HTML / >4096 split path).
    expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 🔵 ANSWER\n');
    expect(p.forceHtml).toBe(true);
  } finally {
    TAG_PILL_IDS.ANSWER = saved;
  }
});

test('buildPrefix --tag with a 3-cell real pill renders 3 <tg-emoji> cells in order', () => {
  const realIds = ['5310000000000000001', '5310000000000000002', '5310000000000000003'];
  const saved = TAG_PILL_IDS.DECISION;
  TAG_PILL_IDS.DECISION = [...realIds];
  try {
    const p = buildPrefix({ aiEmoji: '', model: '', tmuxWindow: '', tag: 'DECISION' });
    const cellTags = p.html.match(/<tg-emoji emoji-id="\d+">/g) ?? [];
    expect(cellTags).toEqual(realIds.map((id) => `<tg-emoji emoji-id="${id}">`));
    // Inner texts re-stitch to the readable label exactly once.
    const innerTexts = [...p.html.matchAll(/<tg-emoji emoji-id="\d+">([^<]*)<\/tg-emoji>/g)].map((m) => m[1]);
    expect(innerTexts.join('')).toBe('🟠 DECISION');
    expect(p.forceHtml).toBe(true);
  } finally {
    TAG_PILL_IDS.DECISION = saved;
  }
});

// Guard regression: a partially-filled pill (one placeholder among real ids) is
// NOT trusted — it falls back to unicode, never a half-broken pill.
test('buildPrefix --tag does NOT emit a pill when any cell id is still a placeholder', () => {
  const saved = TAG_PILL_IDS.PROBLEM;
  TAG_PILL_IDS.PROBLEM = ['5320000000000000001', TAG_PILL_PLACEHOLDER, '5320000000000000003'];
  try {
    const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'PROBLEM' });
    expect(p.html).not.toContain('<tg-emoji');
    expect(p.html).toContain('🔴 PROBLEM'); // unicode fallback instead
  } finally {
    TAG_PILL_IDS.PROBLEM = saved;
  }
});

// --- splitForCells: the pill-label distributor ---
test('splitForCells re-stitches to the original label for every cell count', () => {
  for (const label of ['🔵 ANSWER', '🟠 DECISION', '🔴 PROBLEM', '🟢 REPORT']) {
    for (let n = 1; n <= 4; n++) {
      const chunks = splitForCells(label, n, label.slice(0, 2));
      expect(chunks).toHaveLength(n);
      expect(chunks.join('')).toBe(label); // concatenation is lossless
    }
  }
});

test('splitForCells never bisects the leading dot emoji (splits by code point)', () => {
  // "🔵" is a surrogate pair; the first chunk must contain the WHOLE dot, never
  // a lone half (which would render as a replacement char).
  const chunks = splitForCells('🔵 ANSWER', 2, '🔵');
  expect(chunks[0].startsWith('🔵')).toBe(true);
  expect([...chunks[0]][0]).toBe('🔵'); // first code point is the intact dot
  expect(chunks).toEqual(['🔵 AN', 'SWER']);
});

test('splitForCells with a single cell returns the whole label, and never empties a cell', () => {
  expect(splitForCells('🔵 ANSWER', 1, '🔵')).toEqual(['🔵 ANSWER']);
  // More cells than code points → trailing cells fall back to the dot (never an
  // empty inner text, which would be an invalid <tg-emoji>).
  const chunks = splitForCells('🔵', 3, '🔵');
  expect(chunks).toHaveLength(3);
  expect(chunks.every((c) => c.length > 0)).toBe(true);
});

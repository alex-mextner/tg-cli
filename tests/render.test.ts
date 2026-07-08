import { expect, test } from 'bun:test';
import {
  convertEntitiesToHtml,
  detectHtmlTags,
  escapeHtml,
  parseEmojiHelpers,
  parseModeFor,
} from '../features/render/html';
import { buildPrefix } from '../features/render/prefix';
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

// CodeQL js/incomplete-html-attribute-sanitization: a value carrying a raw `"`
// (or `'`) that reaches an `href="..."` attribute (e.g. tasks-command.ts's
// taskRow) can break out of the attribute and inject markup. escapeHtml must
// neutralize both quote characters, not just the tag/entity delimiters.
test('escapeHtml escapes both quote characters — safe to interpolate into an attribute', () => {
  expect(escapeHtml('"')).toBe('&quot;');
  expect(escapeHtml("'")).toBe('&#39;');
  const evilUrl = `https://x/1" onmouseover="alert(1)`;
  const attr = `<a href="${escapeHtml(evilUrl)}">t</a>`;
  expect(attr).not.toContain('" onmouseover="');
  expect(attr).toBe('<a href="https://x/1&quot; onmouseover=&quot;alert(1)">t</a>');
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
test('parseModeFor follows --format only; plain is NEVER upgraded from content', () => {
  expect(parseModeFor('html')).toBe('HTML');
  // Plain stays plain even when the text looks like HTML — a literal <b> or a pasted
  // link/`://` URL must not be handed to Telegram's HTML entity parser (it 400s with
  // "can't parse entities" on the user's ordinary text). HTML is opt-in via --format html.
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
// Default repo state: TAG_PILL_IDS now holds REAL uploaded custom-emoji ids
// (set replytags_by_hyperidebot), so every known canonical tag renders its
// wordmark pill as N <tg-emoji> cells in the HTML form, while the plain form
// keeps the unicode fallback (`🔵 ANSWER`) for non-HTML / >4096 split paths.
// A placeholder id must NEVER leak into a <tg-emoji>; the half-placeholder
// guard path is tested separately by injecting a placeholder and restoring.

test('buildPrefix --tag (real ids) renders the pill in html, unicode fallback in plain', () => {
  const p = buildPrefix({ aiEmoji: '', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'ANSWER' });
  // plain keeps the unicode fallback badge (non-HTML / >4096 split path).
  expect(p.plain).toBe('[𝘁𝗴-𝗰𝗹𝗶] 🔵 ANSWER\n');
  // html carries ONLY the real 3-cell pill (ANSWER widened to three uploaded
  // cells so the rounded caps don't squish the word); each cell wraps exactly
  // one emoji (Telegram rejects non-emoji fallback text). Per-cell dots are
  // [color, ▫️, ▫️] — cell0 keeps the tag's color, the rest go neutral so a push
  // notification shows ONE colored dot + neutrals (CTO 2026-06-15). The wordmark
  // is baked into the sticker art — NO plain "ANSWER" word is appended (CTO
  // 2026-06-14: first line = --title only, the tag is just the pill badge).
  expect(p.html).toBe(
    '[𝘁𝗴-𝗰𝗹𝗶] ' +
      '<tg-emoji emoji-id="5294303944082762041">🔵</tg-emoji>' +
      '<tg-emoji emoji-id="5294414440706382789">▫️</tg-emoji>' +
      '<tg-emoji emoji-id="5294185480294808567">▫️</tg-emoji>\n',
  );
  // The duplicate plain tag word is GONE: the pill is the only ANSWER label.
  expect(p.html).not.toContain('ANSWER');
  expect(p.forceHtml).toBe(true);
  // Guard: a placeholder string must never appear inside a <tg-emoji> tag.
  expect(p.html).not.toContain('PLACEHOLDER');
  expect(p.plain.endsWith('\n')).toBe(true);
});

test('buildPrefix --tag (lowercase english) resolves to the canonical fallback', () => {
  // Lowercase-english is the ONLY accepted CLI input; the renderer uppercases it
  // and resolves to the canonical pill/fallback.
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'decision' });
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 🟠 DECISION\n');
});

// QUESTION has no uploaded pill asset (TAG_PILL_IDS.QUESTION is PLACEHOLDER),
// unlike ANSWER/DECISION/PROBLEM/REPORT which render a real <tg-emoji> pill for
// premium clients. This is DELIBERATE (review finding, see emoji.ts's comment
// on TAG_PILL_IDS.QUESTION): reusing DECISION's real pill would show a
// DECISION-labeled wordmark to premium viewers while non-premium viewers see
// the correct "QUESTION" text — a visible mismatch. Placeholder keeps EVERY
// viewer on the same unicode fallback until a real pill is uploaded.
test('buildPrefix --tag question ALWAYS renders the unicode fallback (no real pill yet, by design)', () => {
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'question' });
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] 🟠 QUESTION\n');
  expect(p.html).not.toContain('<tg-emoji');
  expect(p.html).not.toContain('PLACEHOLDER');
});

test('buildPrefix --tag (Russian alias) no longer resolves — renders the bare [WORD] badge', () => {
  // Cyrillic is rejected by the CLI (validateTag) before buildPrefix runs; the
  // renderer itself stays total and shows a plain badge for any off-list word.
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'РЕШЕНИЕ' });
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] [РЕШЕНИЕ]\n');
  expect(p.html).not.toContain('<tg-emoji');
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
  // HTML first line: emoji (plain — model 'no-brand' has no branded id),
  // [window], the pill cells (NO plain word), ` — `, then the Bold-Italic styled
  // title. The only readable label is the pill; the title carries its own
  // styling — never the bare tag word.
  expect(p.html).toBe(
    '✳️ [𝘁𝗴-𝗰𝗹𝗶] ' +
      '<tg-emoji emoji-id="5294303944082762041">🔵</tg-emoji>' +
      '<tg-emoji emoji-id="5294414440706382789">▫️</tg-emoji>' +
      '<tg-emoji emoji-id="5294185480294808567">▫️</tg-emoji>' +
      ' — 𝑫𝒐𝒏𝒆\n',
  );
  // The duplicate plain "ANSWER" word is gone — only the styled title is text.
  expect(p.html).not.toContain('ANSWER');
});

// The CTO's exact complaint case: `--tag answer --title "X"`. The first line must
// be the styled --title text only; the tag is the pill badge. NO duplicate plain
// "ANSWER" word anywhere, and the title keeps its Bold-Italic styling.
test('buildPrefix --tag answer --title "X": pill + styled title, no duplicate tag word', () => {
  const p = buildPrefix({
    aiEmoji: '✳️',
    model: 'no-brand',
    tmuxWindow: 'tg-cli',
    tag: 'answer',
    title: 'X',
  });
  expect(p.html).toBe(
    '✳️ [𝘁𝗴-𝗰𝗹𝗶] ' +
      '<tg-emoji emoji-id="5294303944082762041">🔵</tg-emoji>' +
      '<tg-emoji emoji-id="5294414440706382789">▫️</tg-emoji>' +
      '<tg-emoji emoji-id="5294185480294808567">▫️</tg-emoji>' +
      ' — 𝑿\n',
  );
  // No second plain tag word anywhere on the line — the pill is the only label.
  expect(p.html).not.toContain('ANSWER');
  // The title IS styled (Bold-Italic 𝑿), not bare ASCII 'X'.
  expect(p.html).toContain('𝑿');
  expect(p.forceHtml).toBe(true);
});

// All four canonical tags WITH --title: html first line is pill cells + ` — ` +
// styled title, and NO duplicate plain tag word for ANY of them.
test('buildPrefix: each canonical --tag + --title drops the plain word, keeps styled title', () => {
  const cases: Array<[string, string]> = [
    ['ANSWER', 'ANSWER'],
    ['DECISION', 'DECISION'],
    ['PROBLEM', 'PROBLEM'],
    ['REPORT', 'REPORT'],
  ];
  for (const [tag, word] of cases) {
    const p = buildPrefix({ aiEmoji: '', model: 'no-brand', tmuxWindow: 'tg-cli', tag, title: 'Hello' });
    // pill cells present, em-dash, styled title — and no plain wordmark.
    expect(p.html).toContain('<tg-emoji');
    expect(p.html).toContain(' — ');
    expect(p.html).toContain('𝑯𝒆𝒍𝒍𝒐'); // Bold-Italic styled title survives
    expect(p.html).not.toContain(word); // the duplicate plain tag word is gone
    expect(p.html.endsWith('\n')).toBe(true);
  }
});

test('buildPrefix off-list --tag renders a plain [TAG] badge (renderer stays total)', () => {
  // The CLI rejects off-list tags (validateTag) before they reach the renderer;
  // buildPrefix itself never throws and shows a plain badge for any off-list word.
  const p = buildPrefix({ aiEmoji: '✳️', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'wat' });
  expect(p.plain).toBe('✳️ [𝘁𝗴-𝗰𝗹𝗶] [WAT]\n');
  expect(p.html).not.toContain('<tg-emoji'); // off-list tag never emits a pill
  expect(p.present).toBe(true);
});

// Exact rendered header for each of the four canonical tags (the PLAIN form,
// which always keeps the unicode fallback regardless of whether real pill ids
// are wired — the html form carries the <tg-emoji> pill, asserted elsewhere).
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
// Each cell wraps exactly the canonical dot emoji — Telegram rejects a
// custom_emoji entity whose fallback text is not a single emoji.
test('buildPrefix --tag with REAL pill ids renders N <tg-emoji> dot cells and forces HTML', () => {
  const realIds = ['5300000000000000001', '5300000000000000002'];
  const saved = TAG_PILL_IDS.ANSWER;
  TAG_PILL_IDS.ANSWER = [...realIds];
  try {
    const p = buildPrefix({ aiEmoji: '', model: 'no-brand', tmuxWindow: 'tg-cli', tag: 'ANSWER' });
    // N cells (here 2): cell0 = colored dot, the rest neutral ▫️ — and NOTHING
    // after: the wordmark is baked into the sticker art, no plain word appended.
    expect(p.html).toBe(
      '[𝘁𝗴-𝗰𝗹𝗶] ' +
        `<tg-emoji emoji-id="${realIds[0]}">🔵</tg-emoji>` +
        `<tg-emoji emoji-id="${realIds[1]}">▫️</tg-emoji>\n`,
    );
    expect(p.html).not.toContain('ANSWER'); // no duplicate plain tag word
    // Each cell's inner text is a single emoji — cell0 colored, the rest neutral.
    const innerTexts = [...p.html.matchAll(/<tg-emoji emoji-id="\d+">([^<]*)<\/tg-emoji>/g)].map((m) => m[1]);
    expect(innerTexts).toEqual(['🔵', '▫️']);
    // plain keeps the readable unicode fallback (non-HTML / >4096 split path).
    expect(p.plain).toBe('[𝘁𝗴-𝗰𝗹𝗶] 🔵 ANSWER\n');
    expect(p.forceHtml).toBe(true);
  } finally {
    TAG_PILL_IDS.ANSWER = saved;
  }
});

test('buildPrefix --tag with a 3-cell real pill renders 3 <tg-emoji> dot cells in order', () => {
  const realIds = ['5310000000000000001', '5310000000000000002', '5310000000000000003'];
  const saved = TAG_PILL_IDS.DECISION;
  TAG_PILL_IDS.DECISION = [...realIds];
  try {
    const p = buildPrefix({ aiEmoji: '', model: '', tmuxWindow: '', tag: 'DECISION' });
    const cellTags = p.html.match(/<tg-emoji emoji-id="\d+">/g) ?? [];
    expect(cellTags).toEqual(realIds.map((id) => `<tg-emoji emoji-id="${id}">`));
    // 3 cells → cell0 colored, the rest neutral (🟠▫️▫️).
    const innerTexts = [...p.html.matchAll(/<tg-emoji emoji-id="\d+">([^<]*)<\/tg-emoji>/g)].map((m) => m[1]);
    expect(innerTexts).toEqual(['🟠', '▫️', '▫️']);
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

// --- pill cell inner text MUST be a single emoji, [color, ▫️, ▫️] per cell ---
// Telegram rejects a custom_emoji entity whose fallback text is not exactly one
// emoji (ENTITY_TEXT_INVALID), so every <tg-emoji> pill cell's inner text is a
// single dot — never a slice of the readable word. Per-cell layout is
// [colored cell0, neutral ▫️ for the rest] so a push notification shows one
// colored dot identifying the tag + quiet neutrals (CTO 2026-06-15).
test('buildPrefix pill cells each wrap one emoji: [color, ▫️, …] (never a word slice)', () => {
  const cases: Array<[string, string, number]> = [
    ['ANSWER', '🔵', 3],
    ['DECISION', '🟠', 3],
    ['PROBLEM', '🔴', 3],
    ['REPORT', '🟢', 3],
  ];
  for (const [tag, color, cellCount] of cases) {
    const p = buildPrefix({ aiEmoji: '', model: 'no-brand', tmuxWindow: '', tag });
    const inner = [...p.html.matchAll(/<tg-emoji emoji-id="\d+">([^<]*)<\/tg-emoji>/g)].map((m) => m[1]);
    expect(inner).toHaveLength(cellCount); // one cell per uploaded sticker
    const expected = [color, ...Array.from({ length: cellCount - 1 }, () => '▫️')];
    expect(inner).toEqual(expected); // cell0 colored, the rest neutral
    // No cell wraps plain letters (which Telegram would reject).
    expect(p.html).not.toMatch(/<tg-emoji emoji-id="\d+">[^<]*[A-Za-z][^<]*<\/tg-emoji>/);
  }
});

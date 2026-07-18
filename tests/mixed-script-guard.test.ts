import { expect, test } from 'bun:test';
import {
  findMixedScriptTokens,
  formatMixedScriptError,
} from '../features/cli/mixed-script-guard';

// --- findMixedScriptTokens: the detection heuristic ---
// A "garbage" token is a single CONTIGUOUS run of letters that mixes Cyrillic
// with another alphabet (Latin, Greek, …) — the classic homoglyph/mojibake
// signature an LLM occasionally emits mid-word (e.g. "почčesна" = Cyrillic по +
// Latin čes + Cyrillic на). Separate Cyrillic and Latin WORDS in one message are
// fine; only INTRA-run mixing is the bug.

test('flags the reported "почčesна" mojibake (Cyrillic + Latin in one word)', () => {
  const finding = findMixedScriptTokens('починена → почčesна');
  expect(finding).not.toBeNull();
  expect(finding!.tokens[0].token).toBe('почčesна');
});

test('a clean pure-Cyrillic word passes ("починена")', () => {
  expect(findMixedScriptTokens('задача починена, тесты зелёные')).toBeNull();
});

test('a message mixing separate Cyrillic and Latin WORDS passes ("влил PR gh ship")', () => {
  // Both scripts appear, but never inside the SAME letter run — legit.
  expect(findMixedScriptTokens('влил PR gh ship готово')).toBeNull();
  expect(findMixedScriptTokens('dev-cli готово, review прошёл')).toBeNull();
});

test('a single stray Latin letter inside a Cyrillic word is flagged ("починeна")', () => {
  // Latin "e" (U+0065) substituted for Cyrillic "е" (U+0435) — one word, mixed.
  const finding = findMixedScriptTokens('задача починeна');
  expect(finding).not.toBeNull();
  expect(finding!.tokens[0].token).toBe('починeна');
});

test('a Cyrillic word with digits/punctuation (no foreign LETTER) passes', () => {
  expect(findMixedScriptTokens('версия2 готова')).toBeNull();
  expect(findMixedScriptTokens('шаг-3 выполнен')).toBeNull();
  expect(findMixedScriptTokens('готово: 100% (проверено)')).toBeNull();
});

test('a Latin acronym hyphen-joined to a Cyrillic word passes (hyphen breaks the run)', () => {
  // "PR-ревью", "CI-пайплайн" are legit Russian tech compounds — the hyphen is a
  // non-letter, so the Latin and Cyrillic sit in SEPARATE letter runs.
  expect(findMixedScriptTokens('PR-ревью прошло')).toBeNull();
  expect(findMixedScriptTokens('CI-пайплайн зелёный, MCP-сервер поднят')).toBeNull();
});

test('a Latin acronym with a GLUED Cyrillic suffix passes (one boundary, not a sandwich)', () => {
  // The casual Russian dev register: a Latin base + a Cyrillic case/diminutive
  // ending with NO separator. One script transition (Latin → Cyrillic), so it is
  // NOT the mid-word sandwich the guard targets. Must send.
  expect(findMixedScriptTokens('IDшник обновлён')).toBeNull();
  expect(findMixedScriptTokens('прожал PRы, APIшка готова')).toBeNull();
  expect(findMixedScriptTokens('ORMка поднята')).toBeNull();
});

test('a garble with a foreign fragment at a run EDGE is left alone (accepted recall gap)', () => {
  // One boundary reads identically to a legit glued compound (IDшник), so a
  // single leading/trailing foreign letter is a deliberate recall gap. The edge
  // letters are pinned by codepoint so this cannot silently pass with an
  // all-Cyrillic fixture. `--no-feature cjk-guard` is the escape.
  const prefix = 'čинена'; // Latin č (U+010D) then Cyrillic
  const suffix = 'починенa'; // Cyrillic then Latin a (U+0061)
  expect(prefix.codePointAt(0)).toBe(0x010d);
  expect(suffix.codePointAt(suffix.length - 1)).toBe(0x0061);
  expect(findMixedScriptTokens(prefix)).toBeNull();
  expect(findMixedScriptTokens(suffix)).toBeNull();
});

test('a pure-Latin technical token passes (no Cyrillic present)', () => {
  expect(findMixedScriptTokens('deploy finished, all green')).toBeNull();
  expect(findMixedScriptTokens('café résumé naïve')).toBeNull(); // accented Latin
});

test('a Cyrillic word mixed with Greek letters is flagged (same class)', () => {
  // Pinned by codepoint (the scripts are the whole point): д е л ь + Greek τ
  // (U+03C4) + Cyrillic а (U+0430) → Cyr→foreign→Cyr = 2 transitions.
  const garble = 'дельτа';
  const finding = findMixedScriptTokens(`${garble} сломана`);
  expect(finding).not.toBeNull();
  expect(finding!.tokens[0].token).toBe(garble);
});

test('emoji adjacent to a Cyrillic word does not trigger (emoji is not a letter)', () => {
  expect(findMixedScriptTokens('готово ✅ отправляю 🚀')).toBeNull();
});

test('CJK letters are ignored here — left to cjk-guard (structural orthogonality)', () => {
  // CJK neither votes nor creates a transition, so a token whose only non-Cyrillic
  // letters are CJK ("注ляет") is not this guard's concern. And "ка日eat" reduces
  // to Cyrillic→Latin with the 日 skipped = ONE transition (a legit-shaped
  // compound to THIS guard); the stray-CJK guard owns and blocks it at the CLI.
  expect(findMixedScriptTokens('注ляет')).toBeNull();
  expect(findMixedScriptTokens('ка日eat')).toBeNull();
  // A CJK char between two Cyrillic edges must NOT fabricate the 2-transition
  // sandwich for a token whose foreign fragment is only at an EDGE.
  expect(findMixedScriptTokens('č日на')).toBeNull(); // Latin č edge + CJK, 1 real transition
});

test('the Latin-dominant CJK tokens the stray-CJK guard allows also pass this guard', () => {
  // Regression lock for the orthogonality claim: these carry no Cyrillic, so the
  // mixed-script guard is a no-op on them (the stray-CJK guard already lets them
  // through as legit bilingual text).
  expect(findMixedScriptTokens('Deploy到生产')).toBeNull();
  expect(findMixedScriptTokens('3D打印')).toBeNull();
  expect(findMixedScriptTokens('iOS版 shipped')).toBeNull();
  expect(findMixedScriptTokens('React를 배포')).toBeNull();
});

test('reports every garbage token with its 0-based codepoint index', () => {
  const finding = findMixedScriptTokens('ок почčesна и ещё mіr');
  expect(finding).not.toBeNull();
  // "почčesна" starts at codepoint index 3 ("ок " = о к space = 0,1,2).
  expect(finding!.tokens[0].token).toBe('почčesна');
  expect(finding!.tokens[0].index).toBe(3);
  // "mіr" = Latin m + Cyrillic і (U+0456) + Latin r — also mixed.
  expect(finding!.tokens.map((t) => t.token)).toContain('mіr');
});

test('empty / whitespace text passes', () => {
  expect(findMixedScriptTokens('')).toBeNull();
  expect(findMixedScriptTokens('   \n  ')).toBeNull();
});

test('the error message names the offending token and points at the escape hatch', () => {
  const finding = findMixedScriptTokens('почčesна')!;
  const msg = formatMixedScriptError(finding);
  expect(msg).toContain('почčesна');
  expect(msg.toLowerCase()).toContain('mixed');
  expect(msg).toContain('--no-feature cjk-guard');
});

test('the error message joins multiple offending tokens with ", "', () => {
  const finding = findMixedScriptTokens('ок почčesна и mіr тут')!;
  expect(finding.tokens.length).toBe(2);
  const msg = formatMixedScriptError(finding);
  // Both tokens named, comma-joined in one error.
  expect(msg).toContain("'почčesна' at position");
  expect(msg).toContain("'mіr' at position");
  expect(msg).toContain(', ');
});

test('a decomposed accented letter run stays single-script (combining marks do not split)', () => {
  // "e" + combining acute (U+0301) is Latin; no Cyrillic, so it passes.
  expect(findMixedScriptTokens('café deployé')).toBeNull();
});

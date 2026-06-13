// /agent addressing: parse the command, fuzzy-match a tmux window name with
// phonetic normalization, and group candidates by tmux session for button
// selection (item 1, docs/specs/agent-addressing.md).
//
// PURE — the tg-ctl entrypoint owns discovery (the real `tmux list-panes`),
// the pending-message store, the button send and the inject. These functions
// turn plain data into routing decisions and button payloads.

import type { AgentKind } from './types';

export interface AgentCandidate {
  paneId: string; // "%N"
  sessionName: string;
  windowIndex: number;
  windowName: string;
  agent: AgentKind;
}

// --- command parse ---

export interface ParsedAgentCommand {
  // First whitespace token after `/agent` — a POSSIBLE window selector. The
  // caller fuzzy-matches it; if it matches nothing, it is folded back into the
  // message (see `rest` vs `all`).
  selector: string | null;
  rest: string; // message when `selector` IS a window (everything after it)
  all: string; // message when there is NO selector (everything after `/agent`)
}

// `/agent feat-bot deploy now` → selector "feat-bot", rest "deploy now",
// all "feat-bot deploy now". `/agent` alone → selector null, rest/all "".
export function parseAgentCommand(text: string): ParsedAgentCommand {
  const body = text.replace(/^\/agent(@\w+)?\s*/i, '');
  if (!body.trim()) return { selector: null, rest: '', all: '' };
  const m = body.match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return { selector: null, rest: '', all: body.trim() };
  return { selector: m[1], rest: m[2], all: body.trim() };
}

// --- phonetic normalization ---

// Lowercase Cyrillic → Latin so a Russian-typed selector ("клод", "апи бот")
// matches a Latin window name ("claude", "api-bot"). Covers the everyday
// letters; anything unmapped passes through.
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function transliterate(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) out += CYRILLIC[ch] ?? ch;
  return out;
}

// Fold a name to a phonetic key: transliterate, drop separators, apply a few
// sound-equivalences (ph→f, ck→k, qu→kw, w→v, y→i), collapse doubled letters.
// Two names that "sound the same" land on the same key.
export function phoneticKey(s: string): string {
  let t = transliterate(s);
  t = t.replace(/[^a-z0-9]+/g, '');
  t = t.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kw').replace(/x/g, 'ks');
  t = t.replace(/c/g, 'k'); // hard c → k: codex≡кодекс, claude≈клауд
  t = t.replace(/w/g, 'v').replace(/y/g, 'i');
  t = t.replace(/(.)\1+/g, '$1');
  return t;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Score a candidate against a selector key. Lower is better; Infinity = no match.
//   0 exact phonetic key · 1 prefix · 2 substring · 3+ within edit-distance band.
function scoreOf(selKey: string, name: string): number {
  const key = phoneticKey(name);
  if (!key || !selKey) return Infinity;
  if (key === selKey) return 0;
  if (key.startsWith(selKey) || selKey.startsWith(key)) return 1;
  if (key.includes(selKey) || selKey.includes(key)) return 2;
  const d = levenshtein(key, selKey);
  const band = Math.max(1, Math.ceil(Math.max(key.length, selKey.length) / 4));
  return d <= band ? 2 + d : Infinity;
}

export interface MatchResult {
  // Best-scoring candidates (all tied at the best score). Empty when nothing
  // matched well enough.
  matches: AgentCandidate[];
  // True when exactly one candidate is the clear winner → route without asking.
  confident: boolean;
}

// Fuzzy-match `selector` against candidate window names (phonetic). Returns the
// tied best matches; `confident` when that set is a single pane.
export function matchWindows(selector: string, candidates: AgentCandidate[]): MatchResult {
  const selKey = phoneticKey(selector);
  if (!selKey) return { matches: [], confident: false };
  const scored = candidates
    .map((c) => ({ c, score: scoreOf(selKey, c.windowName) }))
    .filter((x) => x.score < Infinity)
    .sort((a, b) => a.score - b.score);
  if (scored.length === 0) return { matches: [], confident: false };
  const best = scored[0].score;
  const matches = scored.filter((x) => x.score === best).map((x) => x.c);
  return { matches, confident: matches.length === 1 };
}

// --- grouping for selection buttons ---

export interface SessionGroup {
  session: string;
  candidates: AgentCandidate[]; // ordered by windowIndex
}

// Group candidates by tmux session, sessions in first-appearance order. Within a
// session, panes are sorted by window index UNLESS `preserveOrder` — the reply
// picker passes the candidates already in LRU/MRU order and must keep it (a
// windowIndex re-sort would discard the most-recent-first ranking).
export function groupBySession(candidates: AgentCandidate[], preserveOrder = false): SessionGroup[] {
  const order: string[] = [];
  const bySession = new Map<string, AgentCandidate[]>();
  for (const c of candidates) {
    const g = bySession.get(c.sessionName);
    if (g) g.push(c);
    else {
      bySession.set(c.sessionName, [c]);
      order.push(c.sessionName);
    }
  }
  return order.map((session) => {
    const inSession = bySession.get(session)!;
    return {
      session,
      candidates: preserveOrder ? inSession : [...inSession].sort((a, b) => a.windowIndex - b.windowIndex),
    };
  });
}

// --- selection button payload ---

const AGENT_CALLBACK_PREFIX = 'tga';

export interface AgentSelectPayload {
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

// Build the "pick an agent" message: the grouped candidate list in the text, one
// button per candidate (labelled `window · agent`), rows grouped by session.
// `token` keys the daemon's pending-message store; callback data is
// `tga:<token>:<index>` where index is into `candidates` (button order).
export function buildAgentSelectMessage(
  chatId: number,
  candidates: AgentCandidate[],
  token: string,
  messagePreview: string,
  preserveOrder = false,
): AgentSelectPayload & { chat_id: number } {
  const groups = groupBySession(candidates, preserveOrder);
  const indexOf = new Map(candidates.map((c, i) => [c, i] as const));
  const lines: string[] = [];
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const g of groups) {
    lines.push(`▸ ${g.session}`);
    for (const c of g.candidates) {
      lines.push(`   ${c.windowName} · ${c.agent}`);
      keyboard.push([
        {
          text: `${c.windowName} · ${c.agent}`,
          callback_data: `${AGENT_CALLBACK_PREFIX}:${token}:${indexOf.get(c)}`,
        },
      ]);
    }
  }
  const head = messagePreview
    ? `Route to which agent?\n“${truncate(messagePreview, 80)}”`
    : 'Route to which agent?';
  return {
    chat_id: chatId,
    text: `${head}\n\n${lines.join('\n')}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

export interface ParsedAgentCallback {
  token: string;
  index: number;
}

// Parse `tga:<token>:<index>` callback data. Returns null on any mismatch.
export function parseAgentCallback(data: string | undefined): ParsedAgentCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== AGENT_CALLBACK_PREFIX || !parts[1]) return null;
  const index = Number(parts[2]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { token: parts[1], index };
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

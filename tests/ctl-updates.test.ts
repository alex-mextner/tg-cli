import { expect, test } from 'bun:test';
import { stepUpdates } from '../features/tg-ctl/updates';
import { DEFAULT_CONTROL, type ControlConfig, type TgMessage, type TgUpdate } from '../features/tg-ctl/types';

const CHAT_ID = 1000;
const NOW = 1_750_000_000; // unix seconds, arbitrary

const wrap = (name: string, msg: string) => `[TG from ${name}] ${msg}`;

function makeOpts(over: Partial<{ cfg: ControlConfig; chatId: number; nowSec: number; currentOffset: number }> = {}) {
  return {
    cfg: { ...DEFAULT_CONTROL, ...(over.cfg ?? {}) },
    chatId: over.chatId ?? CHAT_ID,
    nowSec: over.nowSec ?? NOW,
    currentOffset: over.currentOffset ?? 5,
    wrap,
  };
}

function upd(id: number, msg: Partial<TgMessage> = {}): TgUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: CHAT_ID, first_name: 'Alex' },
      chat: { id: CHAT_ID },
      date: NOW,
      ...msg,
    },
  };
}

// --- offset semantics ---

test('empty input → no actions, offset unchanged', () => {
  const r = stepUpdates([], makeOpts({ currentOffset: 42 }));
  expect(r.actions).toEqual([]);
  expect(r.newOffset).toBe(42);
  expect(r.skippedStale).toBe(0);
});

test('newOffset = max(update_id) + 1 even when updates are unordered', () => {
  const r = stepUpdates([upd(30, { text: 'a' }), upd(28, { text: 'b' })], makeOpts());
  expect(r.newOffset).toBe(31);
});

test('update with no message advances offset silently', () => {
  const r = stepUpdates([{ update_id: 7 }], makeOpts());
  expect(r.actions).toEqual([]);
  expect(r.skippedStale).toBe(0);
  expect(r.newOffset).toBe(8);
});

test('callback_query from allowed sender resolves a button answer and advances offset', () => {
  const r = stepUpdates(
    [
      {
        update_id: 8,
        callback_query: {
          id: 'cb1',
          from: { id: CHAT_ID, first_name: 'Alex' },
          message: { message_id: 50, chat: { id: CHAT_ID }, date: NOW },
          data: 'tgq:q_123:o1',
        },
      },
    ],
    makeOpts(),
  );
  expect(r.actions).toEqual([
    { kind: 'answer-question', callbackQueryId: 'cb1', requestId: 'q_123', value: 'o1', messageId: 50 },
  ]);
  expect(r.newOffset).toBe(9);
});

test('callback_query without a message reference carries messageId null', () => {
  const r = stepUpdates(
    [
      {
        update_id: 8,
        callback_query: {
          id: 'cb1',
          from: { id: CHAT_ID, first_name: 'Alex' },
          data: 'tgq:q_123:o1',
        },
      },
    ],
    makeOpts(),
  );
  expect(r.actions).toEqual([
    { kind: 'answer-question', callbackQueryId: 'cb1', requestId: 'q_123', value: 'o1', messageId: null },
  ]);
});

test('callback_query from disallowed sender is acknowledged but not resolved', () => {
  const r = stepUpdates(
    [
      {
        update_id: 8,
        callback_query: {
          id: 'cb1',
          from: { id: 666, first_name: 'Mallory' },
          message: { message_id: 50, chat: { id: CHAT_ID }, date: NOW },
          data: 'tgq:q_123:o1',
        },
      },
    ],
    makeOpts(),
  );
  expect(r.actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cb1', text: 'not allowed' }]);
  expect(r.newOffset).toBe(9);
});

test('callback_query with unknown data is answered as expired/unknown, not injected', () => {
  const r = stepUpdates(
    [
      {
        update_id: 8,
        callback_query: {
          id: 'cb1',
          from: { id: CHAT_ID, first_name: 'Alex' },
          message: { message_id: 50, chat: { id: CHAT_ID }, date: NOW },
          data: 'other:q_123:o1',
        },
      },
    ],
    makeOpts(),
  );
  expect(r.actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cb1', text: 'expired' }]);
  expect(r.newOffset).toBe(9);
});

test('callback_query actions are prioritized before slower message actions in the same batch', () => {
  const r = stepUpdates(
    [
      upd(7, { photo: [{ file_id: 'photo', file_size: 1024 }] }),
      {
        update_id: 8,
        callback_query: {
          id: 'cb1',
          from: { id: CHAT_ID, first_name: 'Alex' },
          message: { message_id: 50, chat: { id: CHAT_ID }, date: NOW },
          data: 'tgq:q_123:o1',
        },
      },
    ],
    makeOpts(),
  );
  expect(r.actions.map((a) => a.kind)).toEqual(['answer-question', 'download-media', 'ack']);
  expect(r.actions[0]).toEqual({
    kind: 'answer-question',
    callbackQueryId: 'cb1',
    requestId: 'q_123',
    value: 'o1',
    messageId: 50,
  });
  expect(r.newOffset).toBe(9);
});

test('unsupported message kind (no text/photo/document) is silent', () => {
  const r = stepUpdates([upd(9)], makeOpts());
  expect(r.actions).toEqual([]);
  expect(r.newOffset).toBe(10);
});

// --- inbound message_id is forwarded to the wrap (threaded replies) ---

test('a plain text message forwards its message_id to the wrap (for tg --reply-to)', () => {
  // A wrap that renders the id proves textAction passes m.message_id through.
  const wrapWithId = (name: string, msg: string, messageId?: number) =>
    `[TG from ${name}${messageId !== undefined ? ` #${messageId}` : ''}] ${msg}`;
  const opts = { ...makeOpts(), wrap: wrapWithId };
  const r = stepUpdates([upd(4321, { text: 'do the thing' })], opts);
  expect(r.actions[0]).toEqual({ kind: 'inject-text', text: '[TG from Alex #4321] do the thing' });
});

test('the default injectWrap template renders the inbound id as #<id>', () => {
  // Using the SHIPPED template + the real wrapInbound binding the daemon uses.
  const r = stepUpdates([upd(77, { text: 'hi' })], makeOpts());
  // makeOpts' wrap ignores the id, so assert via a real-template wrap instead:
  const realWrap = (name: string, msg: string, messageId?: number) =>
    DEFAULT_CONTROL.injectWrap
      .replace('{name}', name)
      .replace('{msg}', msg)
      .replace('{id}', messageId !== undefined ? `#${messageId}` : '');
  const r2 = stepUpdates([upd(77, { text: 'hi' })], { ...makeOpts(), wrap: realWrap });
  expect(r2.actions[0]).toEqual({ kind: 'inject-text', text: '[TG from Alex #77] hi — reply via tg' });
  // r is just exercising the default path doesn't throw.
  expect(r.actions.length).toBeGreaterThan(0);
});

// --- sender allowlist (spec §9: from.id, not chat id) ---

test('sender matching chatId is allowed', () => {
  const r = stepUpdates([upd(1, { text: 'hi' })], makeOpts());
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex] hi' },
    { kind: 'ack', messageId: 1 },
  ]);
});

test('unknown sender is rejected — no action, offset still advances', () => {
  const r = stepUpdates([upd(1, { text: 'hi', from: { id: 666 } })], makeOpts());
  expect(r.actions).toEqual([]);
  expect(r.skippedStale).toBe(0);
  expect(r.newOffset).toBe(2);
});

test('extra sender in allowedSenders is allowed', () => {
  const opts = makeOpts({ cfg: { ...DEFAULT_CONTROL, allowedSenders: [666] } });
  const r = stepUpdates([upd(1, { text: 'hi', from: { id: 666, username: 'eve' } })], opts);
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from eve] hi' },
    { kind: 'ack', messageId: 1 },
  ]);
});

test('message with no from is rejected', () => {
  const r = stepUpdates([upd(1, { text: 'hi', from: undefined })], makeOpts());
  expect(r.actions).toEqual([]);
  expect(r.newOffset).toBe(2);
});

test("disallowed sender's /kill is ignored entirely", () => {
  const r = stepUpdates([upd(1, { text: '/kill', from: { id: 666 } })], makeOpts());
  expect(r.actions).toEqual([]);
  expect(r.skippedStale).toBe(0);
  expect(r.newOffset).toBe(2);
});

// --- staleness (spec §10) ---

test('stale message is dropped and counted', () => {
  const r = stepUpdates([upd(1, { text: 'old', date: NOW - 301 })], makeOpts());
  expect(r.actions).toEqual([]);
  expect(r.skippedStale).toBe(1);
  expect(r.newOffset).toBe(2);
});

test('message exactly stalenessSec old is NOT stale (strict >)', () => {
  const r = stepUpdates([upd(1, { text: 'edge', date: NOW - 300 })], makeOpts());
  expect(r.actions).toHaveLength(2); // delivery action + its ack
  expect(r.skippedStale).toBe(0);
});

test('stale command is counted stale, never executed', () => {
  const r = stepUpdates([upd(1, { text: '/kill', date: NOW - 9999 })], makeOpts());
  expect(r.actions).toEqual([]);
  expect(r.skippedStale).toBe(1);
});

test('stale message from a disallowed sender does not inflate the stale count', () => {
  const r = stepUpdates([upd(1, { text: 'x', date: NOW - 9999, from: { id: 666 } })], makeOpts());
  expect(r.skippedStale).toBe(0);
  expect(r.newOffset).toBe(2);
});

// --- command split (spec §13) ---

test('/stop → inject-key Escape', () => {
  const r = stepUpdates([upd(1, { text: '/stop' })], makeOpts());
  expect(r.actions).toEqual([
    { kind: 'inject-key', key: 'Escape' },
    { kind: 'ack', messageId: 1 },
  ]);
});

test('/stop with trailing args still maps to Escape (first-token match)', () => {
  const r = stepUpdates([upd(1, { text: '/stop now' })], makeOpts());
  expect(r.actions).toEqual([
    { kind: 'inject-key', key: 'Escape' },
    { kind: 'ack', messageId: 1 },
  ]);
});

test('/kill → kill-agent', () => {
  const r = stepUpdates([upd(1, { text: '/kill' })], makeOpts());
  expect(r.actions).toEqual([{ kind: 'kill-agent' }, { kind: 'ack', messageId: 1 }]);
});

test('/status → status', () => {
  const r = stepUpdates([upd(1, { text: '/status' })], makeOpts());
  expect(r.actions).toEqual([{ kind: 'status' }, { kind: 'ack', messageId: 1 }]);
});

test('unknown /cmd passes through VERBATIM — full text, no wrap', () => {
  const r = stepUpdates([upd(1, { text: '/compact keep the notes' })], makeOpts());
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '/compact keep the notes' },
    { kind: 'ack', messageId: 1 },
  ]);
});

// --- plain text → wrapped inject (wrap fn injected via opts) ---

test('plain text is wrapped with first_name', () => {
  const r = stepUpdates([upd(1, { text: 'do the thing' })], makeOpts());
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex] do the thing' },
    { kind: 'ack', messageId: 1 },
  ]);
});

test('name falls back to username, then "tg"', () => {
  const byUsername = stepUpdates([upd(1, { text: 'a', from: { id: CHAT_ID, username: 'ult' } })], makeOpts());
  expect(byUsername.actions[0]).toEqual({ kind: 'inject-text', text: '[TG from ult] a' });

  const anonymous = stepUpdates([upd(1, { text: 'b', from: { id: CHAT_ID } })], makeOpts());
  expect(anonymous.actions[0]).toEqual({ kind: 'inject-text', text: '[TG from tg] b' });
});

// --- photo inbound (spec §5.2: daemon-chosen filename, largest rendition) ---

test('photo picks the LARGEST file_size, names it <update_id>.jpg', () => {
  const r = stepUpdates(
    [
      upd(77, {
        photo: [
          { file_id: 'small', file_size: 200 },
          { file_id: 'big', file_size: 50_000 },
          { file_id: 'mid', file_size: 1_000 },
        ],
        caption: 'look at this',
      }),
    ],
    makeOpts(),
  );
  expect(r.actions).toEqual([
    {
      kind: 'download-media',
      fileId: 'big',
      suggestedName: '77.jpg',
      mediaKind: 'photo',
      fileSize: 50_000,
      caption: 'look at this',
      from: 'Alex',
      messageId: 77,
    },
    { kind: 'ack', messageId: 77 },
  ]);
});

test('photo renditions without file_size → last entry wins (Telegram is size-ascending)', () => {
  const r = stepUpdates([upd(5, { photo: [{ file_id: 'a' }, { file_id: 'b' }] })], makeOpts());
  expect(r.actions[0]).toMatchObject({ kind: 'download-media', fileId: 'b', suggestedName: '5.jpg' });
});

test('photo over 20MB → reply instead of download', () => {
  const r = stepUpdates([upd(5, { photo: [{ file_id: 'huge', file_size: 20 * 1024 * 1024 + 1 }] })], makeOpts());
  expect(r.actions).toHaveLength(1);
  expect(r.actions[0].kind).toBe('reply');
  expect((r.actions[0] as { kind: 'reply'; text: string }).text).toContain('file too large');
});

// --- document inbound ---

test('document name = <update_id>.<sanitized ext>, NEVER the Telegram basename', () => {
  const r = stepUpdates(
    [upd(88, { document: { file_id: 'doc1', file_name: 'Quarterly Report.PDF', file_size: 1234 }, caption: 'q2' })],
    makeOpts(),
  );
  expect(r.actions).toEqual([
    {
      kind: 'download-media',
      fileId: 'doc1',
      suggestedName: '88.pdf',
      mediaKind: 'document',
      fileSize: 1234,
      caption: 'q2',
      from: 'Alex',
      messageId: 88,
    },
    { kind: 'ack', messageId: 88 },
  ]);
});

test('document extension defaults to bin: missing file_name, no dot, junk ext', () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, '3.bin'],
    ['noext', '3.bin'],
    ['trailing.', '3.bin'],
    ['weird.!!??', '3.bin'],
    ['too.longextension12', '3.bin'],
  ];
  for (const [fileName, expected] of cases) {
    const r = stepUpdates([upd(3, { document: { file_id: 'x', file_name: fileName } })], makeOpts());
    expect(r.actions[0]).toMatchObject({ kind: 'download-media', suggestedName: expected });
  }
});

test('document ext is sanitized to lowercase alphanumerics', () => {
  const r = stepUpdates([upd(4, { document: { file_id: 'x', file_name: 'archive.tar.gz' } })], makeOpts());
  expect(r.actions[0]).toMatchObject({ suggestedName: '4.gz' });
});

test('document over 20MB → reply; exactly 20MB still downloads (strict >)', () => {
  const limit = 20 * 1024 * 1024;
  const over = stepUpdates([upd(1, { document: { file_id: 'x', file_size: limit + 1 } })], makeOpts());
  expect(over.actions[0].kind).toBe('reply');
  expect((over.actions[0] as { kind: 'reply'; text: string }).text).toContain('20 MB');

  const at = stepUpdates([upd(1, { document: { file_id: 'x', file_size: limit } })], makeOpts());
  expect(at.actions[0].kind).toBe('download-media');
});

// --- voice inbound (inbound STT: transcribe-voice action) ---

test('voice note → transcribe-voice with daemon-chosen <update_id>.ogg name, then ack', () => {
  const r = stepUpdates(
    [upd(42, { voice: { file_id: 'voice-abc', duration: 3, mime_type: 'audio/ogg', file_size: 5000 } })],
    makeOpts(),
  );
  expect(r.actions).toEqual([
    {
      kind: 'transcribe-voice',
      fileId: 'voice-abc',
      suggestedName: '42.ogg',
      fileSize: 5000,
      from: 'Alex',
      messageId: 42,
    },
    { kind: 'ack', messageId: 42 },
  ]);
});

test('audio note routes through the same transcribe-voice path as voice', () => {
  const r = stepUpdates([upd(7, { audio: { file_id: 'aud', file_size: 100 } })], makeOpts());
  expect(r.actions[0]).toMatchObject({ kind: 'transcribe-voice', fileId: 'aud', suggestedName: '7.ogg' });
});

test('a voice note that is itself a reply carries the quote anchor for reply-routing', () => {
  const r = stepUpdates(
    [
      upd(9, {
        voice: { file_id: 'v', file_size: 10 },
        reply_to_message: {
          message_id: 3,
          chat: { id: CHAT_ID },
          date: NOW,
          text: 'what is the plan for the migration',
        },
      }),
    ],
    makeOpts(),
  );
  const a = r.actions[0] as Extract<(typeof r.actions)[number], { kind: 'transcribe-voice' }>;
  expect(a.kind).toBe('transcribe-voice');
  expect(a.replyToMessageId).toBe(3);
  expect(a.replyAnchor).toContain('↩');
  expect(a.replyAnchor).toContain('what is the plan');
});

test('voice over 20MB → too-large reply instead of transcribe', () => {
  const r = stepUpdates([upd(1, { voice: { file_id: 'huge', file_size: 20 * 1024 * 1024 + 1 } })], makeOpts());
  expect(r.actions).toHaveLength(1);
  expect(r.actions[0].kind).toBe('reply');
  expect((r.actions[0] as { kind: 'reply'; text: string }).text).toContain('file too large');
});

test('voice from a disallowed sender is dropped entirely', () => {
  const r = stepUpdates([upd(1, { voice: { file_id: 'v' }, from: { id: 666 } })], makeOpts());
  expect(r.actions).toEqual([]);
  expect(r.newOffset).toBe(2);
});

// --- batch combinations ---

test('batch: ordered actions, stale counted, intruder dropped, offset correct', () => {
  const updates: TgUpdate[] = [
    upd(10, { text: 'hello' }),
    upd(11, { text: '/status' }),
    { update_id: 12 }, // non-message update
    upd(13, { text: 'late', date: NOW - 1000 }), // stale
    upd(14, { text: '/kill', from: { id: 666 } }), // intruder
    upd(15, { text: 'world' }),
  ];
  const r = stepUpdates(updates, makeOpts());
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex] hello' },
    { kind: 'ack', messageId: 10 },
    { kind: 'status' },
    { kind: 'ack', messageId: 11 },
    { kind: 'inject-text', text: '[TG from Alex] world' },
    { kind: 'ack', messageId: 15 },
  ]);
  expect(r.skippedStale).toBe(1);
  expect(r.newOffset).toBe(16);
});

// --- delivery receipts (👀 reaction, spec §10) ---

test('a pure error reply (too-large) earns NO ack — the reply IS the failure signal', () => {
  const r = stepUpdates([upd(5, { photo: [{ file_id: 'huge', file_size: 21 * 1024 * 1024 }] })], makeOpts());
  expect(r.actions).toEqual([{ kind: 'reply', text: 'file too large for Bot API (>20 MB)' }]);
});

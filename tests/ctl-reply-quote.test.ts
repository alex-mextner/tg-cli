import { expect, test } from 'bun:test';
import { buildReplyInject, stepUpdates, type StepOpts } from '../features/tg-ctl/updates';
import { DEFAULT_CONTROL, type TgMessage, type TgUpdate } from '../features/tg-ctl/types';

const CHAT_ID = 1000;
const NOW = 1_750_000_000;
const REPLIED_AT = 1_700_000_000;

const opts: StepOpts = {
  cfg: { ...DEFAULT_CONTROL },
  chatId: CHAT_ID,
  nowSec: NOW,
  currentOffset: 0,
  wrap: (name, msg) => `[TG from ${name}] ${msg} — reply via tg`,
  fmtTime: () => '2026-06-12 14:30',
};

const replied = (text: string): TgMessage => ({
  message_id: 0,
  chat: { id: CHAT_ID },
  date: REPLIED_AT,
  text,
});

const reply = (text: string, rtmText: string, quote?: string): TgMessage => ({
  message_id: 9,
  from: { id: CHAT_ID, first_name: 'Alex' },
  chat: { id: CHAT_ID },
  date: NOW,
  text,
  reply_to_message: replied(rtmText),
  ...(quote ? { quote: { text: quote } } : {}),
});

// --- buildReplyInject ---

test('partial quote is forwarded as the quote anchor (item 2)', () => {
  const out = buildReplyInject(reply('fix the bug', 'Deployed auth and migrated the DB', 'migrated the DB'), 'Alex', opts);
  expect(out).toBe('↩ «[2026-06-12 14:30] migrated the DB…»\n[TG from Alex] fix the bug — reply via tg');
});

test('no partial quote → beginning of the replied-to message (item 3)', () => {
  const out = buildReplyInject(reply('do it', 'Short original message', undefined), 'Alex', opts);
  expect(out).toBe('↩ «[2026-06-12 14:30] Short original message…»\n[TG from Alex] do it — reply via tg');
});

test('long original is truncated to the head + ellipsis', () => {
  const long = 'x'.repeat(120);
  const out = buildReplyInject(reply('y', long, undefined), 'Alex', opts);
  const anchor = out.split('\n')[0];
  expect(anchor).toBe(`↩ «[2026-06-12 14:30] ${'x'.repeat(60)}…»`);
});

test('multiline original/quote is collapsed to one anchor line', () => {
  const out = buildReplyInject(reply('ok', 'line one\nline two', 'line\none'), 'Alex', opts);
  expect(out.split('\n')[0]).toBe('↩ «[2026-06-12 14:30] line one…»');
});

test('default UTC formatter is deterministic when fmtTime is omitted', () => {
  const o: StepOpts = { ...opts, fmtTime: undefined };
  const out = buildReplyInject(reply('a', 'b', undefined), 'Alex', o);
  expect(out.split('\n')[0]).toMatch(/^↩ «\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] b…»$/);
});

// --- stepUpdates integration ---

function upd(id: number, m: TgMessage): TgUpdate {
  return { update_id: id, message: m };
}

test('reply with prose → reply-route with the quote anchor + ack', () => {
  const r = stepUpdates([upd(1, reply('please fix', 'Original report text', 'report text'))], opts);
  expect(r.actions[0]).toEqual({
    kind: 'reply-route',
    replyToMessageId: 0,
    injectText: '↩ «[2026-06-12 14:30] report text…»\n[TG from Alex] please fix — reply via tg',
    from: 'Alex',
  });
  expect(r.actions[1]).toEqual({ kind: 'ack', messageId: 9 });
});

test('reply whose text is a /command runs the command, not a quote forward', () => {
  const m = reply('/stop', 'Original', undefined);
  const r = stepUpdates([upd(2, m)], opts);
  expect(r.actions[0]).toEqual({ kind: 'inject-key', key: 'Escape' });
});

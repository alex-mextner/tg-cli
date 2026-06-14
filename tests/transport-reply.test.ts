import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTelegramTransport } from '../features/transport/telegram';

// createTelegramTransport hits the Bot API via global fetch. Stub fetch to
// capture the request bodies so we can assert reply_to_message_id wiring without
// touching the network. checkResponse reads { ok: true, result }, so the stub
// returns a minimal valid Message.

const realFetch = globalThis.fetch;
let bodies: Array<Record<string, unknown>>;

beforeEach(() => {
  bodies = [];
  let nextId = 100;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: nextId++ } }),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const CTX = { api: 'https://api.telegram.org/botTEST', chatId: '42', recordRoute: () => {} };

test('reply_to_message_id is set on sendMessage when replyToMessageId is given', async () => {
  const t = createTelegramTransport({ ...CTX, replyToMessageId: 1234 });
  await t.sendMessage('threaded answer', 'plain');
  expect(bodies).toHaveLength(1);
  expect(bodies[0].reply_to_message_id).toBe(1234);
  expect(bodies[0].text).toBe('threaded answer');
});

test('NO reply_to_message_id is set when none is given (back-compat)', async () => {
  const t = createTelegramTransport(CTX);
  await t.sendMessage('plain message', 'plain');
  expect(bodies).toHaveLength(1);
  expect('reply_to_message_id' in bodies[0]).toBe(false);
});

test('only the FIRST message threads — continuation chunks do not re-reply', async () => {
  const t = createTelegramTransport({ ...CTX, replyToMessageId: 55 });
  await t.sendMessage('first chunk', 'plain');
  await t.sendMessage('second chunk', 'plain');
  expect(bodies).toHaveLength(2);
  expect(bodies[0].reply_to_message_id).toBe(55);
  expect('reply_to_message_id' in bodies[1]).toBe(false);
});

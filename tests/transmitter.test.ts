import { expect, test } from 'bun:test';
import { transmit, type Transport } from '../features/auto-attach/transmitter';
import type { SendPlan, SendItem } from '../features/auto-attach/types';

// A fake transport records every call instead of hitting the network.
function fakeTransport() {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const t: Transport = {
    sendMessage: async (text, format) => {
      calls.push({ method: 'sendMessage', args: { text, format } });
    },
    sendPhoto: async (item, caption, format) => {
      calls.push({ method: 'sendPhoto', args: { item, caption, format } });
    },
    sendDocument: async (item, caption, format) => {
      calls.push({ method: 'sendDocument', args: { item, caption, format } });
    },
  };
  return { t, calls };
}

const photo = (path: string): SendItem => ({ type: 'photo', source: { kind: 'disk', path } });
const doc = (path: string): SendItem => ({ type: 'document', source: { kind: 'disk', path } });

function plan(p: Partial<SendPlan>): SendPlan {
  return { photos: [], textMessages: [], documents: [], ...p };
}

test('ordering: photos → text → documents (sandwich)', async () => {
  const { t, calls } = fakeTransport();
  // Use a >1024 caption so the text does NOT ride a media caption and is sent
  // as a separate middle message — the case that exercises all three sections.
  const big = 'x'.repeat(2000);
  await transmit(
    plan({
      photos: [photo('/a.png')],
      textMessages: [{ text: big, format: 'plain' }],
      documents: [doc('/b.pdf')],
    }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage', 'sendDocument']);
});

test('single photo with short caption rides as the photo caption', async () => {
  const { t, calls } = fakeTransport();
  await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: 'small', format: 'plain' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendPhoto');
  expect(calls[0].args.caption).toBe('small');
});

test('caption > 1024: photo sent WITHOUT caption + text sent as separate message', async () => {
  const { t, calls } = fakeTransport();
  const big = 'x'.repeat(2000);
  await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: big, format: 'plain' }] }), t);
  const photoCall = calls.find((c) => c.method === 'sendPhoto')!;
  expect(photoCall.args.caption).toBeUndefined();
  const msgCall = calls.find((c) => c.method === 'sendMessage')!;
  expect(msgCall.args.text).toBe(big);
  // Order is still photo before the separate text message.
  expect(calls.indexOf(photoCall)).toBeLessThan(calls.indexOf(msgCall));
});

test('text > 4096 is split into multiple sendMessage calls', async () => {
  const { t, calls } = fakeTransport();
  const huge = ('para ' + 'y'.repeat(900) + '\n\n').repeat(8); // > 4096
  await transmit(plan({ textMessages: [{ text: huge, format: 'plain' }] }), t);
  const msgs = calls.filter((c) => c.method === 'sendMessage');
  expect(msgs.length).toBeGreaterThan(1);
  for (const m of msgs) expect((m.args.text as string).length).toBeLessThanOrEqual(4096);
});

test('multiple photos with short caption: caption goes on the first photo only', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({
      photos: [photo('/a.png'), photo('/b.png')],
      textMessages: [{ text: 'cap', format: 'plain' }],
    }),
    t,
  );
  const photoCalls = calls.filter((c) => c.method === 'sendPhoto');
  expect(photoCalls.length).toBe(2);
  expect(photoCalls[0].args.caption).toBe('cap');
  expect(photoCalls[1].args.caption).toBeUndefined();
});

test('text-only with documents: caption rides the first document when short', async () => {
  const { t, calls } = fakeTransport();
  await transmit(plan({ documents: [doc('/a.pdf')], textMessages: [{ text: 'note', format: 'plain' }] }), t);
  // No photos → text can ride as the document caption.
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendDocument');
  expect(calls[0].args.caption).toBe('note');
});

test('text-only plan sends a single message', async () => {
  const { t, calls } = fakeTransport();
  await transmit(plan({ textMessages: [{ text: 'just text', format: 'plain' }] }), t);
  expect(calls).toEqual([{ method: 'sendMessage', args: { text: 'just text', format: 'plain' } }]);
});

test('photos + text + documents: text rides photo caption (short), docs follow', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({
      photos: [photo('/a.png')],
      textMessages: [{ text: 'cap', format: 'plain' }],
      documents: [doc('/b.pdf')],
    }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendDocument']);
  expect(calls[0].args.caption).toBe('cap');
  expect(calls[1].args.caption).toBeUndefined();
});

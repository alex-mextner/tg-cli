import { expect, test } from 'bun:test';
import { transmit, visibleLength, type Transport } from '../features/auto-attach/transmitter';
import type { SendPlan, SendItem } from '../features/auto-attach/types';

test('visibleLength ignores HTML tags + counts unescaped entities', () => {
  expect(visibleLength('plain', 'plain')).toBe(5);
  expect(visibleLength('<b>hi</b>', 'html')).toBe(2);
  expect(visibleLength('a &lt; b &amp; c', 'html')).toBe('a < b & c'.length);
});

test('visibleLength: single-pass decode does not double-unescape, tag-strip is complete', () => {
  // js/double-escaping guard: `&amp;lt;` must decode to the literal `&lt;`
  // (4 chars), never collapse to `<`.
  expect(visibleLength('&amp;lt;', 'html')).toBe('&lt;'.length);
  // js/incomplete-multi-character-sanitization guard: a dangling, unterminated
  // tag at end-of-string contributes ZERO visible length (it is stripped, not
  // left behind as it was under the old /<[^>]+>/g). An unescaped trailing `<b`
  // is malformed Telegram HTML anyway (a real `<` must be `&lt;`).
  expect(visibleLength('hi <script', 'html')).toBe('hi '.length);
  expect(visibleLength('see a<b', 'html')).toBe('see a'.length);
});

test('HTML caption: raw length > 1024 but VISIBLE <= 1024 still rides as caption', () => {
  const calls: Array<{ method: string }> = [];
  const t: Transport = {
    sendMessage: async () => {
      calls.push({ method: 'sendMessage' });
    },
    sendPhoto: async () => {
      calls.push({ method: 'sendPhoto' });
    },
    sendDocument: async () => {
      calls.push({ method: 'sendDocument' });
    },
    sendMediaGroup: async () => {
      calls.push({ method: 'sendMediaGroup' });
    },
    sendRich: async () => {
      calls.push({ method: 'sendRich' });
    },
  };
  // 1000 visible chars wrapped in a tag → raw length > 1024 but visible 1000.
  const text = '<b>' + 'x'.repeat(1000) + '</b>';
  const plan: SendPlan = {
    photos: [{ type: 'photo', source: { kind: 'disk', path: '/a.png' } }],
    textMessages: [{ text, format: 'html' }],
    documents: [],
  };
  return transmit(plan, t).then(() => {
    // Rode as the photo caption → no separate sendMessage.
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
  });
});

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
    sendMediaGroup: async (kind, items, caption, format) => {
      calls.push({ method: 'sendMediaGroup', args: { kind, items, caption, format } });
    },
    sendRich: async (html) => {
      calls.push({ method: 'sendRich', args: { html } });
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

// FIX 2 (album restore): >=2 photos go out as ONE sendMediaGroup, not N
// individual sendPhoto messages. The short caption rides the album (first item).
test('multiple photos with short caption: ONE sendMediaGroup album, caption on the album', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({
      photos: [photo('/a.png'), photo('/b.png')],
      textMessages: [{ text: 'cap', format: 'plain' }],
    }),
    t,
  );
  // Exactly one album call carrying both photos — no separate sendPhoto calls.
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup']);
  const album = calls[0];
  expect(album.args.kind).toBe('photo');
  expect((album.args.items as SendItem[]).length).toBe(2);
  expect(album.args.caption).toBe('cap');
});

test('FIX 2: exactly ONE photo still uses sendPhoto (a 1-item album is invalid)', async () => {
  const { t, calls } = fakeTransport();
  await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: 'cap', format: 'plain' }] }), t);
  expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
  expect(calls[0].args.caption).toBe('cap');
});

test('FIX 2: >=2 documents go out as ONE sendMediaGroup document album', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({ documents: [doc('/a.pdf'), doc('/b.pdf')], textMessages: [{ text: 'note', format: 'plain' }] }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup']);
  expect(calls[0].args.kind).toBe('document');
  expect((calls[0].args.items as SendItem[]).length).toBe(2);
  expect(calls[0].args.caption).toBe('note');
});

test('FIX 2: photo album + >1024 caption → album caption-less + SEPARATE text message', async () => {
  const { t, calls } = fakeTransport();
  const big = 'x'.repeat(2000);
  await transmit(
    plan({ photos: [photo('/a.png'), photo('/b.png')], textMessages: [{ text: big, format: 'plain' }] }),
    t,
  );
  const album = calls.find((c) => c.method === 'sendMediaGroup')!;
  expect(album.args.caption).toBeUndefined();
  const msg = calls.find((c) => c.method === 'sendMessage')!;
  expect(msg.args.text).toBe(big);
  // Album (photos) still precedes the separate text message.
  expect(calls.indexOf(album)).toBeLessThan(calls.indexOf(msg));
});

test('FIX 2: ordering with albums — photo album → text → document album', async () => {
  const { t, calls } = fakeTransport();
  const big = 'x'.repeat(2000); // >1024 so text does NOT ride a caption
  await transmit(
    plan({
      photos: [photo('/a.png'), photo('/b.png')],
      textMessages: [{ text: big, format: 'plain' }],
      documents: [doc('/c.pdf'), doc('/d.pdf')],
    }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage', 'sendMediaGroup']);
  expect((calls[0].args.items as SendItem[]).length).toBe(2);
  expect(calls[0].args.kind).toBe('photo');
  expect((calls[2].args.items as SendItem[]).length).toBe(2);
  expect(calls[2].args.kind).toBe('document');
});

test('FIX 2: >10 photos are chunked into 10-item albums (Telegram cap), caption on the very first', async () => {
  const { t, calls } = fakeTransport();
  const photos = Array.from({ length: 23 }, (_, i) => photo(`/p${i}.png`));
  await transmit(plan({ photos, textMessages: [{ text: 'cap', format: 'plain' }] }), t);
  // 23 → albums of 10 + 10 + 3.
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMediaGroup', 'sendMediaGroup']);
  expect((calls[0].args.items as SendItem[]).length).toBe(10);
  expect((calls[1].args.items as SendItem[]).length).toBe(10);
  expect((calls[2].args.items as SendItem[]).length).toBe(3);
  // Caption only on the first album.
  expect(calls[0].args.caption).toBe('cap');
  expect(calls[1].args.caption).toBeUndefined();
  expect(calls[2].args.caption).toBeUndefined();
});

test('FIX 2: a trailing single item after a full album falls back to sendPhoto (1-item group is invalid)', async () => {
  const { t, calls } = fakeTransport();
  const photos = Array.from({ length: 11 }, (_, i) => photo(`/p${i}.png`));
  await transmit(plan({ photos }), t);
  // 11 → album of 10 + a lone sendPhoto (a 1-item group would be rejected).
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendPhoto']);
  expect((calls[0].args.items as SendItem[]).length).toBe(10);
});

test('FIX 2: short caption rides the PHOTO album when both albums present', async () => {
  const { t, calls } = fakeTransport();
  await transmit(
    plan({
      photos: [photo('/a.png'), photo('/b.png')],
      textMessages: [{ text: 'cap', format: 'plain' }],
      documents: [doc('/c.pdf'), doc('/d.pdf')],
    }),
    t,
  );
  expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMediaGroup']);
  // Photo album carries the caption; document album does not.
  expect(calls[0].args.kind).toBe('photo');
  expect(calls[0].args.caption).toBe('cap');
  expect(calls[1].args.kind).toBe('document');
  expect(calls[1].args.caption).toBeUndefined();
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

// --- rich-message routing (Bot API sendRichMessage) ------------------------

test('rich HTML body (table) routes to sendRich, NOT sendMessage', async () => {
  const { t, calls } = fakeTransport();
  const html = '<h1>Report</h1><table><tr><td>a</td></tr></table>';
  await transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendRich');
  expect(calls[0].args.html).toBe(html);
});

test('basic HTML body (only <b>) routes to sendMessage, NOT sendRich', async () => {
  const { t, calls } = fakeTransport();
  const html = '<b>bold</b> plain report';
  await transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendMessage');
});

test('a rich body is sent WHOLE (never 4096-split)', async () => {
  const { t, calls } = fakeTransport();
  // A rich body well over 4096 chars but under the 500-block / 32768-char rich
  // limits: 50 list items of ~100-char text = >5000 chars, 51 blocks. A plain
  // sendMessage would 4096-split it; sendRich sends it as one call.
  const items = `<li>${'word '.repeat(20)}</li>`.repeat(50);
  const html = '<ul>' + items + '</ul>';
  expect(html.length).toBeGreaterThan(4096);
  await transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendRich');
});

test('a rich body never rides as a media caption', async () => {
  const { t, calls } = fakeTransport();
  // Short rich HTML (< 1024 visible) alongside a photo: a basic short caption
  // would ride the photo, but a rich body must be its own sendRich message.
  const html = '<table><tr><td>x</td></tr></table>';
  await transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: html, format: 'html' }] }), t);
  const methods = calls.map((c) => c.method);
  expect(methods).toContain('sendRich');
  expect(methods).toContain('sendPhoto');
  // The photo went out caption-less (the rich body did not ride it).
  const photoCall = calls.find((c) => c.method === 'sendPhoto')!;
  expect(photoCall.args.caption).toBeUndefined();
});

test('an in-document-link <a href="#..."> body routes to sendRich', async () => {
  const { t, calls } = fakeTransport();
  const html = 'jump to <a href="#chapter-2">chapter 2</a>';
  await transmit(plan({ textMessages: [{ text: html, format: 'html' }] }), t);
  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('sendRich');
});

test('invalid rich HTML + a photo: NOTHING is sent (preflight before media)', async () => {
  const { t, calls } = fakeTransport();
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__exit__');
  }) as typeof process.exit;
  try {
    // 21 columns → over the 20-column limit. The photo must NOT be sent.
    const overWide = '<table><tr>' + '<td>c</td>'.repeat(21) + '</tr></table>';
    await expect(
      transmit(plan({ photos: [photo('/a.png')], textMessages: [{ text: overWide, format: 'html' }] }), t),
    ).rejects.toThrow('__exit__');
    expect(exitCode).toBe(1);
    // No send of any kind happened — the photo did not go out orphaned.
    expect(calls).toHaveLength(0);
  } finally {
    process.exit = origExit;
  }
});

import { expect, test } from 'bun:test';
import { EMBEDDABLE_EMOJI_MAP } from '../features/branding/emoji';
import { parseEmojiHelpers } from '../features/render/html';
import { buildPrefix } from '../features/render/prefix';
import { createTelegramTransport } from '../features/transport/telegram';

// Cross-module contract tests for the `tg` decomposition (Stages 1-2). These
// pin the two non-obvious contracts a multi-model review flagged as the most
// likely ways a "zero behaviour change" split silently breaks despite the
// end-to-end suite staying green:
//   1. the render modules must read the LIVE shared emoji maps by reference,
//      so main()'s runtime TG_EMOJI_IDS overrides are still observed after the
//      reader moved into another module;
//   2. createTelegramTransport must record exactly one route per returned
//      message id — including one per item of a media-group array.

test('render modules observe a post-import mutation of the shared emoji map', () => {
  const key = 'unitspecmodel';
  const fakeId = '1234567890123456789';
  // Simulate the main()-side TG_EMOJI_IDS override mutating the singleton AFTER
  // features/render/* were imported (top of this file). A snapshot/copy in the
  // extracted module would miss this; a live by-reference read sees it.
  EMBEDDABLE_EMOJI_MAP[key] = fakeId;
  try {
    const parsed = parseEmojiHelpers(`:${key}:`);
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].custom_emoji_id).toBe(fakeId);

    const p = buildPrefix({ aiEmoji: '🤖', model: key, tmuxWindow: '' });
    expect(p.html).toBe(`<tg-emoji emoji-id="${fakeId}">🤖</tg-emoji> `);
    expect(p.forceHtml).toBe(true);
  } finally {
    delete EMBEDDABLE_EMOJI_MAP[key];
  }
});

test('createTelegramTransport records one route per returned message id (incl. each album item)', async () => {
  const recorded: number[] = [];
  const origFetch = globalThis.fetch;
  // Fake Telegram: single-message methods return one Message; sendMediaGroup
  // returns an array of Messages. No real network.
  globalThis.fetch = (async (url: string | URL | Request) => {
    const result = String(url).endsWith('/sendMediaGroup')
      ? [{ message_id: 10 }, { message_id: 11 }, { message_id: 12 }]
      : { message_id: 7 };
    return { ok: true, json: async () => ({ ok: true, result }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const t = createTelegramTransport({
      api: 'https://example.invalid/botTEST',
      chatId: '42',
      recordRoute: (id) => recorded.push(id),
    });

    await t.sendMessage('hi', 'plain');
    expect(recorded).toEqual([7]);

    recorded.length = 0;
    await t.sendMediaGroup(
      'photo',
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'photo', source: { kind: 'memory', content: 'a', filename: 'a.png' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'photo', source: { kind: 'memory', content: 'b', filename: 'b.png' } } as any,
      ],
      'cap',
      'plain',
    );
    // recordRouteFromResult walks the array → one route per album item, in order
    expect(recorded).toEqual([10, 11, 12]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

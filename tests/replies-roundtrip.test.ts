// Round-trip: the exact on-disk JSONL the WRITERS produce (inbound via
// inboundHistoryRecords, outbound via outboundHistoryText) must be readable by
// the READER (runReplies) through a real file. Guards the wire format end to end
// without a live Telegram bot.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inboundHistoryRecords } from '../features/replies/inbound';
import { outboundHistoryText } from '../features/replies/outbound';
import { appendRecordsToBlob, type HistoryRecord } from '../features/replies/history';
import { runReplies } from '../features/replies/cli';
import type { TgUpdate } from '../features/tg-ctl/types';

const CHAT = 555;

test('inbound writer → file → tg replies reader, scoped to the routed pane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-replies-'));
  const file = join(dir, 'history.jsonl');

  const updates: TgUpdate[] = [
    {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: CHAT },
        date: 1700000000,
        from: { id: CHAT, first_name: 'Alex' },
        text: 'ship it',
      },
    },
  ];
  const inbound = inboundHistoryRecords(updates, { chatId: CHAT, allowedSenders: [], pane: '%4' });
  writeFileSync(file, appendRecordsToBlob(null, inbound));

  const out: string[] = [];
  const code = runReplies(['replies'], {
    readHistory: () => readFileSync(file, 'utf8'),
    detectPane: () => '%4',
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: () => {},
  });
  expect(code).toBe(0);
  expect(out).toEqual(['[T] #10 ship it']);
});

test('outbound writer → file → tg replies agent reader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-replies-'));
  const file = join(dir, 'history.jsonl');

  const text = outboundHistoryText('done, shipped', { photos: 0, documents: 0 });
  expect(text).not.toBeNull();
  const rec: HistoryRecord = {
    ts: 1700000200,
    message_id: 99,
    direction: 'agent',
    from: 'agent',
    text: text!,
    pane: '%4',
  };
  writeFileSync(file, appendRecordsToBlob(null, [rec]));

  const out: string[] = [];
  runReplies(['replies', 'agent'], {
    readHistory: () => readFileSync(file, 'utf8'),
    detectPane: () => '%4',
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: () => {},
  });
  expect(out).toEqual(['[T] #99 done, shipped']);
});

test('both writers append to the SAME file; `all` shows the conversation in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-replies-'));
  const file = join(dir, 'history.jsonl');

  // Inbound first.
  const inbound = inboundHistoryRecords(
    [
      {
        update_id: 1,
        message: {
          message_id: 10,
          chat: { id: CHAT },
          date: 1700000000,
          from: { id: CHAT, first_name: 'Alex' },
          text: 'status?',
        },
      },
    ],
    { chatId: CHAT, allowedSenders: [], pane: '%4' },
  );
  writeFileSync(file, appendRecordsToBlob(null, inbound));

  // Then outbound appends to the existing blob.
  const reply: HistoryRecord = {
    ts: 1700000050,
    message_id: 11,
    direction: 'agent',
    from: 'agent',
    text: 'all green',
    pane: '%4',
  };
  writeFileSync(file, appendRecordsToBlob(readFileSync(file, 'utf8'), [reply]));

  const out: string[] = [];
  runReplies(['replies', 'all'], {
    readHistory: () => readFileSync(file, 'utf8'),
    detectPane: () => '%4',
    fmtTime: () => 'T',
    log: (m) => out.push(m),
    errlog: () => {},
  });
  expect(out).toEqual(['← [T] #10 status?', '→ [T] #11 all green']);
});

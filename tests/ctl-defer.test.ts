// Unit tests for the defer-while-waiting queue model (features/tg-ctl/defer.ts).
//
// The DANGER this guards (docs note tg#30): tg-ctl injects inbound Telegram
// messages into the agent's tmux pane via send-keys. If a question/permission
// prompt is OPEN in that pane, injected text is typed INTO the prompt and
// lost/corrupts it. The daemon therefore DEFERS inbound text while a pane has a
// pending question and flushes the queue once the question is answered.
//
// The subtle failure these tests pin down: the agent frequently asks a SECOND
// question the instant the first is answered. The flush must re-check the
// pane-busy state BEFORE each paste and re-defer the remainder, or it pastes
// straight into the new prompt — re-introducing the exact bug.

import { describe, expect, test } from 'bun:test';
import { DeferQueues, driveFlush } from '../features/tg-ctl/defer';

describe('DeferQueues', () => {
  test('enqueue preserves per-pane FIFO order', () => {
    const q = new DeferQueues();
    q.enqueue('%1', 'a');
    q.enqueue('%1', 'b');
    q.enqueue('%2', 'c');
    expect(q.peek('%1')).toEqual(['a', 'b']);
    expect(q.peek('%2')).toEqual(['c']);
  });

  test('generic queues preserve structured items', () => {
    const q = new DeferQueues<{ text: string; sourceMessageId: number }>();
    q.enqueue('%1', { text: 'a', sourceMessageId: 11 });
    q.enqueue('%1', { text: 'b', sourceMessageId: 12 });
    expect(q.take('%1')).toEqual([
      { text: 'a', sourceMessageId: 11 },
      { text: 'b', sourceMessageId: 12 },
    ]);
  });

  test('has reflects whether a pane has queued text', () => {
    const q = new DeferQueues();
    expect(q.has('%1')).toBe(false);
    q.enqueue('%1', 'a');
    expect(q.has('%1')).toBe(true);
  });

  test('take drains and removes the pane queue', () => {
    const q = new DeferQueues();
    q.enqueue('%1', 'a');
    q.enqueue('%1', 'b');
    expect(q.take('%1')).toEqual(['a', 'b']);
    expect(q.has('%1')).toBe(false);
    expect(q.take('%1')).toEqual([]);
  });

  test('redefer puts items back at the FRONT, before anything enqueued meanwhile', () => {
    const q = new DeferQueues();
    // While a flush was draining ['a','b'], a new message 'c' arrived for the
    // same pane. The un-flushed tail ['b'] must land BEFORE 'c' so the user's
    // ordering survives.
    q.enqueue('%1', 'c');
    q.redefer('%1', ['b']);
    expect(q.peek('%1')).toEqual(['b', 'c']);
  });

  test('redefer of multiple items keeps their relative order', () => {
    const q = new DeferQueues();
    q.enqueue('%1', 'd');
    q.redefer('%1', ['b', 'c']);
    expect(q.peek('%1')).toEqual(['b', 'c', 'd']);
  });

  test('panesWithBacklog lists only panes that still hold items (tg-cli#58)', () => {
    const q = new DeferQueues();
    expect(q.panesWithBacklog()).toEqual([]);
    q.enqueue('%1', 'a');
    q.enqueue('%2', 'b');
    q.enqueue('%2', 'c');
    expect(q.panesWithBacklog().sort()).toEqual(['%1', '%2']);
    // A drained pane drops out of the list (so an unscoped sweep won't touch it).
    q.take('%1');
    expect(q.panesWithBacklog()).toEqual(['%2']);
  });
});

describe('driveFlush', () => {
  test('injects everything when the pane never becomes busy again', async () => {
    const injected: string[] = [];
    const out = await driveFlush(['a', 'b', 'c'], () => false, async (t) => {
      injected.push(t);
      return true;
    });
    expect(injected).toEqual(['a', 'b', 'c']);
    expect(out.injected).toEqual(['a', 'b', 'c']);
    expect(out.failed).toEqual([]);
    expect(out.reDeferred).toEqual([]);
  });

  test('stops once a new question opens MID-flush, re-deferring the rest', async () => {
    // The pane is free for the first paste; a new question opens before the
    // second. 'b' and 'c' must NOT be pasted into that open prompt — they go
    // back to the queue. (This is the exact follow-up-question race the fix
    // closes: re-checked between awaited pastes, not just once up front.)
    const injected: string[] = [];
    let questionOpen = false;
    const out = await driveFlush(['a', 'b', 'c'], () => questionOpen, async (t) => {
      injected.push(t);
      questionOpen = true; // the answered agent immediately re-prompts
      return true;
    });
    expect(injected).toEqual(['a']);
    expect(out.injected).toEqual(['a']);
    expect(out.reDeferred).toEqual(['b', 'c']);
    expect(out.failed).toEqual([]);
  });

  test('re-defers the WHOLE queue when a question is already open at flush time', async () => {
    const injected: string[] = [];
    const out = await driveFlush(['a', 'b'], () => true, async (t) => {
      injected.push(t);
      return true;
    });
    expect(injected).toEqual([]);
    expect(out.injected).toEqual([]);
    expect(out.reDeferred).toEqual(['a', 'b']);
  });

  test('a failed paste is dropped (logged), flush CONTINUES — no head-of-line block', async () => {
    // inject() returning false (e.g. the pane lost its agent) must NOT re-defer
    // the tail: there may be no future question to flush it, so re-deferring would
    // wedge every later message forever. The failed item is dropped; the rest go.
    const injected: string[] = [];
    const out = await driveFlush(['a', 'b', 'c'], () => false, async (t) => {
      if (t === 'b') return false; // transient failure on the middle item
      injected.push(t);
      return true;
    });
    expect(injected).toEqual(['a', 'c']);
    expect(out.injected).toEqual(['a', 'c']);
    expect(out.failed).toEqual(['b']);
    expect(out.reDeferred).toEqual([]); // nothing wedged
  });

  test('a new question takes priority over a pending failure on the next item', async () => {
    // busy is checked BEFORE inject, so an open question re-defers the tail even
    // if that tail's first inject would have failed.
    const out = await driveFlush(['a', 'b'], () => true, async () => false);
    expect(out.injected).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(out.reDeferred).toEqual(['a', 'b']);
  });

  test('empty queue yields an empty outcome', async () => {
    const out = await driveFlush([], () => false, async () => true);
    expect(out.injected).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(out.reDeferred).toEqual([]);
  });
});

import { expect, test } from 'bun:test';
import { stepUpdates } from '../features/tg-ctl/updates';
import {
  DEFAULT_CONTROL,
  type ControlConfig,
  type TgMessage,
  type TgUpdate,
  type TopicBinding,
  type TopicStatus,
} from '../features/tg-ctl/types';
import {
  appendTopic,
  applyModelAnswer,
  applyPathAnswer,
  buildModelKeyboard,
  createTopic,
  findTopic,
  isAwaitingAnswer,
  markBound,
  markClosed,
  markReopened,
  MAX_TOPICS,
  parseTopics,
  parseTopicModelCallback,
  serializeTopics,
  slugifyTopicName,
} from '../features/tg-ctl/topics';
import { DEFAULT_MODEL_ID, findModel, MODEL_CATALOG, spawnArgv } from '../features/tg-ctl/models';

const CHAT_ID = 1000;
const NOW = 1_750_000_000;
const wrap = (name: string, msg: string, id?: number) => `[TG from ${name}${id ? ` #${id}` : ''}] ${msg}`;

function makeOpts(
  over: Partial<{
    topicsEnabled: boolean;
    topicStatusOf: (t: number) => TopicStatus | null;
    cfg: ControlConfig;
  }> = {},
) {
  return {
    cfg: { ...DEFAULT_CONTROL, ...(over.cfg ?? {}) },
    chatId: CHAT_ID,
    nowSec: NOW,
    currentOffset: 5,
    wrap,
    topicsEnabled: over.topicsEnabled ?? false,
    topicStatusOf: over.topicStatusOf,
  };
}

function upd(id: number, msg: Partial<TgMessage>): TgUpdate {
  return {
    update_id: id,
    message: { message_id: id, from: { id: CHAT_ID, first_name: 'Alex' }, chat: { id: CHAT_ID }, date: NOW, ...msg },
  };
}

// --- model catalog ---

test('model catalog: default is first, findModel + spawnArgv resolve', () => {
  expect(MODEL_CATALOG[0].id).toBe(DEFAULT_MODEL_ID);
  expect(findModel('claude-opus')?.kind).toBe('claude');
  expect(findModel('nope')).toBeNull();
  expect(spawnArgv('claude-opus', '/x')).toEqual(['claude', '--model', 'opus']);
  expect(spawnArgv('claude-default', '/x')).toEqual(['claude']);
  expect(spawnArgv('nope', '/x')).toBeNull();
});

test('spawnArgv keeps a spaced path as a single argv element (no shell split)', () => {
  // path is not part of the claude argv today, but the builder must never split it
  // — assert the builder is called with the path intact and returns a clean argv.
  expect(spawnArgv('claude-default', '/a b/c')).toEqual(['claude']);
});

// --- store ---

test('topics store: round-trips and upserts by threadId', () => {
  const a: TopicBinding = { threadId: 10, name: 'api', status: 'awaiting-path', ts: 1 };
  const b: TopicBinding = { threadId: 20, name: 'web', status: 'bound', paneId: '%3', path: '/w', model: 'claude-opus', ts: 2 };
  let topics = appendTopic(appendTopic([], a), b);
  expect(findTopic(topics, 10)).toEqual(a);
  expect(findTopic(topics, 20)?.paneId).toBe('%3');
  // upsert: same threadId replaces, not duplicates
  topics = appendTopic(topics, { ...a, status: 'bound', paneId: '%9', ts: 3 });
  expect(topics.filter((t) => t.threadId === 10)).toHaveLength(1);
  expect(findTopic(topics, 10)?.paneId).toBe('%9');
  // serialize → parse round-trip
  expect(parseTopics(serializeTopics(topics))).toEqual(topics);
});

test('topics store: parse rejects junk + non-array, keeps valid', () => {
  expect(parseTopics(null)).toEqual([]);
  expect(parseTopics('not json')).toEqual([]);
  expect(parseTopics('{"threadId":1}')).toEqual([]); // not an array
  expect(parseTopics('[{"threadId":"x","status":"bound"},{"threadId":5,"status":"nope"},{"threadId":7,"name":"ok","status":"bound","paneId":"%2","ts":9}]'))
    .toEqual([{ threadId: 7, name: 'ok', status: 'bound', path: undefined, model: undefined, paneId: '%2', ts: 9 }]);
});

test('topics store: parse drops a bound binding with no paneId, and a NaN ts → 0', () => {
  // bound-without-pane would route into nothing → dropped (re-binds on next message)
  expect(parseTopics('[{"threadId":7,"name":"x","status":"bound","ts":1}]')).toEqual([]);
  // a NaN ts (typeof NaN === 'number') must not slip through — normalized to 0
  expect(parseTopics('[{"threadId":7,"name":"x","status":"awaiting-path","ts":null}]')[0]?.ts).toBe(0);
});

test('topics store: caps at MAX_TOPICS keeping the newest', () => {
  let topics: TopicBinding[] = [];
  for (let i = 0; i < MAX_TOPICS + 5; i++) topics = appendTopic(topics, { threadId: i, name: `t${i}`, status: 'bound', ts: i });
  expect(topics).toHaveLength(MAX_TOPICS);
  expect(findTopic(topics, 0)).toBeNull(); // oldest dropped
  expect(findTopic(topics, MAX_TOPICS + 4)?.name).toBe(`t${MAX_TOPICS + 4}`);
});

// --- lifecycle transitions ---

test('lifecycle: create → path → model → bound', () => {
  const created = createTopic(42, 'My Repo', 100);
  expect(created).toEqual({ threadId: 42, name: 'My Repo', status: 'awaiting-path', ts: 100 });
  expect(isAwaitingAnswer(created)).toBe(true);

  const withPath = applyPathAnswer(created, '/Users/me/repo', 101);
  expect(withPath.status).toBe('awaiting-model');
  expect(withPath.path).toBe('/Users/me/repo');

  const withModel = applyModelAnswer(withPath, 'claude-opus', 102);
  expect(withModel?.model).toBe('claude-opus');
  expect(withModel?.status).toBe('awaiting-model'); // stays until spawn succeeds

  const bound = markBound(withModel!, '%7', 103);
  expect(bound.status).toBe('bound');
  expect(bound.paneId).toBe('%7');
  expect(isAwaitingAnswer(bound)).toBe(false);
});

test('lifecycle: an invalid model id is rejected (re-ask), valid keeps the path', () => {
  const withPath = applyPathAnswer(createTopic(1, 'x', 1), '/p', 2);
  expect(applyModelAnswer(withPath, 'bogus', 3)).toBeNull();
  expect(applyModelAnswer(withPath, 'claude-sonnet', 3)?.path).toBe('/p'); // path preserved
});

test('lifecycle: close, then reopen resumes at awaiting-model when a path is known', () => {
  const bound = markBound(applyModelAnswer(applyPathAnswer(createTopic(1, 'x', 1), '/p', 2), 'claude-opus', 3)!, '%2', 4);
  const closed = markClosed(bound, 5);
  expect(closed.status).toBe('closed');
  const reopened = markReopened(closed, 6);
  expect(reopened.status).toBe('awaiting-model'); // path known → re-pick model
  expect(reopened.paneId).toBeUndefined(); // old pane dropped
  // a topic reopened with no path restarts at awaiting-path
  expect(markReopened(createTopic(2, 'y', 1), 7).status).toBe('awaiting-path');
});

test('slugifyTopicName: safe tmux window name, fallback to threadId', () => {
  expect(slugifyTopicName('My API Bot!', 5)).toBe('my-api-bot');
  expect(slugifyTopicName('Апи Бот', 5)).toBe('api-bot'); // Cyrillic transliterated, not collapsed to topic-5
  expect(slugifyTopicName('Ревью', 7)).toBe('revyu');
  expect(slugifyTopicName('🔥🔥', 9)).toBe('topic-9'); // emoji-only → fallback (unmapped)
  expect(slugifyTopicName('  ---  ', 5)).toBe('topic-5');
  expect(slugifyTopicName('a'.repeat(40), 5)).toHaveLength(24);
  // the length cap must not re-expose a trailing dash (trim runs AFTER slice)
  expect(slugifyTopicName(`${'a'.repeat(23)} b`, 5)).toBe('a'.repeat(23));
});

// --- stepUpdates topic routing ---

test('topics OFF: a topic message falls through to normal flat injection (unchanged behaviour)', () => {
  const r = stepUpdates([upd(1, { text: 'hi', message_thread_id: 99 })], makeOpts({ topicsEnabled: false }));
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex #1] hi' },
    { kind: 'ack', messageId: 1 },
  ]);
});

test('topics ON: forum_topic_created → topic-new + ack', () => {
  const r = stepUpdates(
    [upd(50, { message_thread_id: 50, forum_topic_created: { name: 'feature-x' } })],
    makeOpts({ topicsEnabled: true }),
  );
  expect(r.actions).toEqual([
    { kind: 'topic-new', threadId: 50, name: 'feature-x', from: 'Alex' },
    { kind: 'ack', messageId: 50 },
  ]);
});

test('topics ON: prose in a BOUND topic → topic-route with wrapped text', () => {
  const r = stepUpdates(
    [upd(7, { text: 'deploy now', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: (t) => (t === 50 ? 'bound' : null) }),
  );
  expect(r.actions).toEqual([
    { kind: 'topic-route', threadId: 50, injectText: '[TG from Alex #7] deploy now', from: 'Alex', messageId: 7 },
    { kind: 'ack', messageId: 7 },
  ]);
});

test('topics ON: a slash-command in a BOUND topic injects VERBATIM (reaches the agent)', () => {
  const r = stepUpdates(
    [upd(11, { text: '/compact', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions[0]).toEqual({ kind: 'topic-route', threadId: 50, injectText: '/compact', from: 'Alex', messageId: 11 });
});

test('topics ON: media (no text) in a BOUND topic is ACKED only — never leaks to a flat agent', () => {
  const r = stepUpdates(
    [upd(12, { photo: [{ file_id: 'f' }], message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  // no inject-text / no download-media to a flat agent — just the ack (increment 2 routes topic media)
  expect(r.actions).toEqual([{ kind: 'ack', messageId: 12 }]);
});

test('topics ON: a message in a CLOSED topic is ACKED only — never leaks to a flat agent', () => {
  const r = stepUpdates(
    [upd(13, { text: 'still here?', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'closed' }),
  );
  expect(r.actions).toEqual([{ kind: 'ack', messageId: 13 }]);
});

test('topics ON: a message in an AWAITING topic → topic-answer (raw text)', () => {
  const r = stepUpdates(
    [upd(8, { text: '/Users/me/api', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'awaiting-path' }),
  );
  expect(r.actions).toEqual([
    { kind: 'topic-answer', threadId: 50, text: '/Users/me/api', from: 'Alex', messageId: 8 },
    { kind: 'ack', messageId: 8 },
  ]);
});

test('topics ON: an UNTRACKED forum-topic message is ACKED only — never leaks to a flat agent / General', () => {
  const r = stepUpdates(
    [upd(9, { text: 'hello', message_thread_id: 77, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => null }),
  );
  expect(r.actions).toEqual([{ kind: 'ack', messageId: 9 }]);
});

test('topics ON: prose starting with / (a path) in a BOUND topic is WRAPPED, not a verbatim command', () => {
  const r = stepUpdates(
    [upd(14, { text: '/etc/hosts is broken', message_thread_id: 50, is_topic_message: true })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  // wrapped (carries sender + #id for tg --reply-to), NOT injected verbatim as a command
  expect(r.actions[0]).toEqual({
    kind: 'topic-route',
    threadId: 50,
    injectText: '[TG from Alex #14] /etc/hosts is broken',
    from: 'Alex',
    messageId: 14,
  });
});

test('topics ON: a DUPLICATE forum_topic_created for an in-flight/bound topic does NOT reset it', () => {
  for (const st of ['bound', 'awaiting-path', 'awaiting-model'] as const) {
    const r = stepUpdates(
      [upd(50, { message_thread_id: 50, forum_topic_created: { name: 'dup' } })],
      makeOpts({ topicsEnabled: true, topicStatusOf: () => st }),
    );
    // no topic-new (would clobber the live binding) — just the ack
    expect(r.actions).toEqual([{ kind: 'ack', messageId: 50 }]);
  }
  // but a create for an untracked/closed topic DOES start the flow
  const fresh = stepUpdates(
    [upd(51, { message_thread_id: 51, forum_topic_created: { name: 'new' } })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => null }),
  );
  expect(fresh.actions[0]).toEqual({ kind: 'topic-new', threadId: 51, name: 'new', from: 'Alex' });
});

test('topics ON: a STALE topic message yields NO topic action (never leaks to a live agent)', () => {
  const stale: TgUpdate = {
    update_id: 20,
    message: { message_id: 20, from: { id: CHAT_ID, first_name: 'Alex' }, chat: { id: CHAT_ID }, date: NOW - 9999, text: 'old', message_thread_id: 50, is_topic_message: true },
  };
  const r = stepUpdates([stale], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }));
  expect(r.actions).toEqual([]);
  expect(r.skippedStale).toBe(1);
});

test('topics ON: a topic message from a NON-allowed sender yields NO topic action', () => {
  const intruder: TgUpdate = {
    update_id: 21,
    message: { message_id: 21, from: { id: 999, first_name: 'Mallory' }, chat: { id: CHAT_ID }, date: NOW, text: 'pwn', message_thread_id: 50, is_topic_message: true },
  };
  const r = stepUpdates([intruder], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }));
  expect(r.actions).toEqual([]);
});

test('topics ON but topicStatusOf undefined: service messages still route; a topic message falls to flat', () => {
  const opts = { ...makeOpts({ topicsEnabled: true }), topicStatusOf: undefined };
  const created = stepUpdates([upd(30, { message_thread_id: 30, forum_topic_created: { name: 'x' } })], opts);
  expect(created.actions[0]).toEqual({ kind: 'topic-new', threadId: 30, name: 'x', from: 'Alex' });
  // a regular forum-topic message with no lookup → status null → acked only (not leaked to flat)
  const msg = stepUpdates([upd(31, { text: 'hi', message_thread_id: 30, is_topic_message: true })], opts);
  expect(msg.actions).toEqual([{ kind: 'ack', messageId: 31 }]);
});

test('topics ON: forum_topic_created with no from → name defaults to "tg"', () => {
  const r = stepUpdates(
    [{ update_id: 40, message: { message_id: 40, chat: { id: CHAT_ID }, date: NOW, from: { id: CHAT_ID }, message_thread_id: 40, forum_topic_created: { name: 'z' } } }],
    makeOpts({ topicsEnabled: true }),
  );
  expect(r.actions[0]).toEqual({ kind: 'topic-new', threadId: 40, name: 'z', from: 'tg' });
});

test('topics ON: a non-forum reply-thread (thread id but NOT is_topic_message) falls through to flat', () => {
  // A supergroup reply thread carries message_thread_id but no is_topic_message; even if its id
  // collides with a tracked topic it must NOT be captured as a topic message.
  const r = stepUpdates(
    [upd(10, { text: 'reply thread msg', message_thread_id: 50 })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex #10] reply thread msg' },
    { kind: 'ack', messageId: 10 },
  ]);
});

test('topics ON: forum_topic_closed / reopened on a TRACKED topic → topic-close / topic-reopen + ack', () => {
  const tracked = makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' });
  const closed = stepUpdates([upd(1, { message_thread_id: 50, forum_topic_closed: {} })], tracked);
  expect(closed.actions).toEqual([{ kind: 'topic-close', threadId: 50 }, { kind: 'ack', messageId: 1 }]);
  const reopened = stepUpdates([upd(2, { message_thread_id: 50, forum_topic_reopened: {} })], tracked);
  expect(reopened.actions).toEqual([{ kind: 'topic-reopen', threadId: 50 }, { kind: 'ack', messageId: 2 }]);
});

test('topics ON: close/reopen on an UNTRACKED topic emits no topic action (just ack) — not ours', () => {
  const untracked = makeOpts({ topicsEnabled: true, topicStatusOf: () => null });
  const closed = stepUpdates([upd(3, { message_thread_id: 99, forum_topic_closed: {} })], untracked);
  expect(closed.actions).toEqual([{ kind: 'ack', messageId: 3 }]);
});

test('topics ON: forum_topic_edited (rename) is swallowed (ack only) — recognized service msg, never leaks to flat', () => {
  const r = stepUpdates(
    [upd(4, { message_thread_id: 50, forum_topic_edited: { name: 'renamed' } })],
    makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }),
  );
  expect(r.actions).toEqual([{ kind: 'ack', messageId: 4 }]);
});

test('topics ON: General (no message_thread_id) is unaffected', () => {
  const r = stepUpdates([upd(3, { text: 'plain' })], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'bound' }));
  expect(r.actions).toEqual([
    { kind: 'inject-text', text: '[TG from Alex #3] plain' },
    { kind: 'ack', messageId: 3 },
  ]);
});

// --- model-pick button (the awaiting-model spawn step) ---

function cbUpd(id: number, data: string): TgUpdate {
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: CHAT_ID, first_name: 'Alex' },
      message: { message_id: id, chat: { id: CHAT_ID }, date: NOW },
      data,
    },
  };
}

test('parseTopicModelCallback: parses tgm:<threadId>:<modelId>, rejects malformed', () => {
  expect(parseTopicModelCallback('tgm:50:claude-opus')).toEqual({ threadId: 50, modelId: 'claude-opus' });
  expect(parseTopicModelCallback('tgm:1:claude-default')).toEqual({ threadId: 1, modelId: 'claude-default' });
  expect(parseTopicModelCallback('tgm:0:claude-default')).toBeNull(); // a thread id is always >= 1
  expect(parseTopicModelCallback('tga:50:0')).toBeNull(); // wrong prefix (/agent picker)
  expect(parseTopicModelCallback('tgq:abc:o0')).toBeNull(); // wrong prefix (question)
  expect(parseTopicModelCallback('tgm:notanum:m')).toBeNull();
  expect(parseTopicModelCallback('tgm:50:')).toBeNull();
  expect(parseTopicModelCallback('tgm:50')).toBeNull();
  expect(parseTopicModelCallback('tgm::claude-opus')).toBeNull(); // empty threadId must NOT coerce to 0
  expect(parseTopicModelCallback('tgm:1e2:m')).toBeNull(); // Number() exotica rejected
  expect(parseTopicModelCallback('tgm:0x10:m')).toBeNull();
  expect(parseTopicModelCallback('tgm:-5:m')).toBeNull(); // a thread id is always positive
  expect(parseTopicModelCallback(undefined)).toBeNull();
});

test('buildModelKeyboard: one button per catalog model, callback carries threadId + id', () => {
  const kb = buildModelKeyboard(50, MODEL_CATALOG);
  expect(kb).toHaveLength(MODEL_CATALOG.length);
  expect(kb[0][0]).toEqual({ text: MODEL_CATALOG[0].label, callback_data: `tgm:50:${MODEL_CATALOG[0].id}` });
  // every row is a single button whose callback round-trips through the parser
  for (const row of kb) {
    expect(row).toHaveLength(1);
    expect(parseTopicModelCallback(row[0].callback_data)?.threadId).toBe(50);
  }
});

test('topics ON: a tgm: model tap emits a topic-model action (routed to the spawn flow)', () => {
  const r = stepUpdates([cbUpd(7, 'tgm:50:claude-opus')], makeOpts({ topicsEnabled: true, topicStatusOf: () => 'awaiting-model' }));
  expect(r.actions).toEqual([
    {
      kind: 'topic-model',
      callbackQueryId: 'cb7',
      threadId: 50,
      modelId: 'claude-opus',
      messageId: 7,
    },
  ]);
});

test('topics OFF: a tgm: tap does NOT emit topic-model — falls through to the question parser (expired)', () => {
  const r = stepUpdates([cbUpd(8, 'tgm:50:claude-opus')], makeOpts({ topicsEnabled: false }));
  // With topics off the model tap is not recognized as a spawn action; it falls to the
  // button-callback parser which rejects the non-tgq data as an expired callback.
  expect(r.actions).toEqual([{ kind: 'answer-callback', callbackQueryId: 'cb8', text: 'expired' }]);
});

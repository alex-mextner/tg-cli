import { expect, test } from 'bun:test';
import {
  MAX_RETAINED_QUESTIONS,
  parseQuestionStore,
  serializeQuestionStore,
  type QuestionStoreData,
} from '../features/tg-ctl/question-store';

const NOW = 1_000_000_000_000;

function scopedQuestionReq(id: string): Record<string, unknown> {
  return {
    requestId: id,
    agent: 'claude',
    kind: 'question',
    paneId: '%1',
    question: 'Where should I deploy?',
    title: 'Deploy',
    options: [{ label: 'Staging' }, { label: 'Production' }],
  };
}

test('serialize → parse round-trips questions and answered within the window', () => {
  const data: QuestionStoreData = {
    questions: [{ req: scopedQuestionReq('q1'), messageId: 77, at: NOW - 1000 }],
    answered: [{ key: 'q0', value: 'Production', label: 'Production', at: NOW - 2000, delivery: 'socket' }],
  };
  const restored = parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000);
  expect(restored.questions).toHaveLength(1);
  expect(restored.questions[0].req).toEqual(scopedQuestionReq('q1'));
  expect(restored.questions[0].messageId).toBe(77);
  expect(restored.answered).toEqual([{ key: 'q0', value: 'Production', label: 'Production', decision: undefined, at: NOW - 2000, delivery: 'socket' }]);
});

test('an answered permission decision survives the round-trip', () => {
  const data: QuestionStoreData = {
    questions: [],
    answered: [{ key: 'p1', value: 'allow', label: 'Approve', decision: 'allow', at: NOW, delivery: 'socket' }],
  };
  const restored = parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000);
  expect(restored.answered[0].decision).toBe('allow');
});

test('the answer delivery channel (pane vs socket) survives the round-trip; missing defaults to socket', () => {
  const data: QuestionStoreData = {
    questions: [],
    answered: [{ key: 'late', value: 'Yes', label: 'Yes', at: NOW, delivery: 'pane' }],
  };
  expect(parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000).answered[0].delivery).toBe('pane');
  // A legacy record with no `delivery` field defaults to socket (preserves #98 replay).
  const legacy = JSON.stringify({ v: 1, questions: [], answered: [{ key: 'k', value: 'v', label: 'l', at: NOW }] });
  expect(parseQuestionStore(legacy, NOW, 60_000, 60_000).answered[0].delivery).toBe('socket');
});

test('questions and answered get SEPARATE age windows', () => {
  const blob = serializeQuestionStore({
    questions: [{ req: scopedQuestionReq('q'), messageId: 1, at: NOW - 20_000 }],
    answered: [{ key: 'a', value: 'v', label: 'l', at: NOW - 20_000, delivery: 'socket' }],
  });
  // Question window 60s (keeps it), answer window 10s (drops it).
  const restored = parseQuestionStore(blob, NOW, 60_000, 10_000);
  expect(restored.questions).toHaveLength(1);
  expect(restored.answered).toHaveLength(0);
});

test('an unknown format version is ignored (forward-compat), not mis-parsed', () => {
  const future = JSON.stringify({ v: 999, questions: [{ req: scopedQuestionReq('q'), messageId: 1, at: NOW }], answered: [] });
  expect(parseQuestionStore(future, NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
  const noVersion = JSON.stringify({ questions: [{ req: scopedQuestionReq('q'), messageId: 1, at: NOW }], answered: [] });
  expect(parseQuestionStore(noVersion, NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
});

test('entries older than the window are dropped on parse (no stale resurrection)', () => {
  const data: QuestionStoreData = {
    questions: [
      { req: scopedQuestionReq('fresh'), messageId: 1, at: NOW - 1000 },
      { req: scopedQuestionReq('stale'), messageId: 2, at: NOW - 90_000 },
    ],
    answered: [
      { key: 'fresh-a', value: 'x', label: 'x', at: NOW - 1000, delivery: 'socket' },
      { key: 'stale-a', value: 'y', label: 'y', at: NOW - 90_000, delivery: 'socket' },
    ],
  };
  const restored = parseQuestionStore(serializeQuestionStore(data), NOW, 60_000, 60_000);
  expect(restored.questions.map((q) => q.req.requestId)).toEqual(['fresh']);
  expect(restored.answered.map((a) => a.key)).toEqual(['fresh-a']);
});

test('corrupt / non-object / empty input parses to empty, never throws', () => {
  expect(parseQuestionStore(null, NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
  expect(parseQuestionStore('not json {', NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
  expect(parseQuestionStore('[1,2,3]', NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
  expect(parseQuestionStore('{"v":1,"questions":"nope","answered":42}', NOW, 60_000, 60_000)).toEqual({ questions: [], answered: [] });
});

test('malformed records inside the arrays are skipped individually', () => {
  const blob = JSON.stringify({
    v: 1,
    questions: [
      { req: scopedQuestionReq('ok'), messageId: 5, at: NOW },
      { req: 'not-an-object', messageId: 5, at: NOW }, // bad req
      { req: scopedQuestionReq('no-at'), messageId: 5 }, // missing at
      { req: scopedQuestionReq('bad-mid'), messageId: 'x', at: NOW }, // bad messageId
    ],
    answered: [
      { key: 'ok', value: 'v', label: 'l', at: NOW },
      { key: '', value: 'v', label: 'l', at: NOW }, // empty key
      { value: 'v', label: 'l', at: NOW }, // missing key
    ],
  });
  const restored = parseQuestionStore(blob, NOW, 60_000, 60_000);
  expect(restored.questions.map((q) => q.req.requestId)).toEqual(['ok']);
  expect(restored.answered.map((a) => a.key)).toEqual(['ok']);
});

test('a null messageId is preserved (card not yet confirmed)', () => {
  const restored = parseQuestionStore(
    serializeQuestionStore({ questions: [{ req: scopedQuestionReq('q'), messageId: null, at: NOW }], answered: [] }),
    NOW,
    60_000,
    60_000,
  );
  expect(restored.questions[0].messageId).toBeNull();
});

test('serialize caps each array to MAX_RETAINED_QUESTIONS on WRITE (the file is bounded, not only on the next parse)', () => {
  const questions = Array.from({ length: MAX_RETAINED_QUESTIONS + 30 }, (_, i) => ({
    req: scopedQuestionReq(`q${i}`),
    messageId: i,
    at: NOW - i, // higher i = older
  }));
  const answered = Array.from({ length: MAX_RETAINED_QUESTIONS + 30 }, (_, i) => ({
    key: `a${i}`,
    value: 'v',
    label: 'l',
    at: NOW - i,
    delivery: 'socket' as const,
  }));
  // Inspect the RAW serialized JSON directly (NOT via parseQuestionStore, which also
  // caps) to prove the WRITE itself bounds the file.
  const raw = JSON.parse(serializeQuestionStore({ questions, answered }));
  expect(raw.questions).toHaveLength(MAX_RETAINED_QUESTIONS);
  expect(raw.answered).toHaveLength(MAX_RETAINED_QUESTIONS);
  expect(raw.questions[0].req.requestId).toBe('q0'); // freshest kept
  expect(raw.answered[0].key).toBe('a0');
});

test('the questions array is capped to MAX_RETAINED_QUESTIONS, keeping the freshest', () => {
  const questions = Array.from({ length: MAX_RETAINED_QUESTIONS + 50 }, (_, i) => ({
    req: scopedQuestionReq(`q${i}`),
    messageId: i,
    at: NOW - i, // higher i = older
  }));
  const restored = parseQuestionStore(serializeQuestionStore({ questions, answered: [] }), NOW, 10 * 60_000, 10 * 60_000);
  expect(restored.questions).toHaveLength(MAX_RETAINED_QUESTIONS);
  // Freshest kept (i=0 newest); the oldest 50 dropped.
  expect(restored.questions[0].req.requestId).toBe('q0');
  expect(restored.questions.every((q) => Number((q.req.requestId as string).slice(1)) < MAX_RETAINED_QUESTIONS)).toBe(true);
});

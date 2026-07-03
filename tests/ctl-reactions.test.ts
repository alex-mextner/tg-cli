import { expect, test } from 'bun:test';
import {
  ALLOWED_REACTIONS,
  doneReactionForSend,
  INTENDED_REACTIONS,
  isAllowedReaction,
  reactionForStage,
  REACTION_DONE,
  REACTION_STALLED,
  REACTION_WORKING,
} from '../features/tg-ctl/reactions';

test('every lifecycle stage emoji is in the Bot API allowed set', () => {
  for (const stage of ['working', 'stalled', 'done'] as const) {
    expect(isAllowedReaction(reactionForStage(stage))).toBe(true);
  }
});

test('the emoji Alex literally named are NOT allowed — proxies are used instead', () => {
  // The whole reason this module exists: ⏳/✅ are REACTION_INVALID.
  expect(isAllowedReaction(INTENDED_REACTIONS.stalled)).toBe(false); // ⏳
  expect(isAllowedReaction(INTENDED_REACTIONS.done)).toBe(false); // ✅
  expect(REACTION_STALLED).not.toBe(INTENDED_REACTIONS.stalled);
  expect(REACTION_DONE).not.toBe(INTENDED_REACTIONS.done);
});

test('stage → emoji mapping', () => {
  expect(reactionForStage('working')).toBe(REACTION_WORKING);
  expect(reactionForStage('stalled')).toBe(REACTION_STALLED);
  expect(reactionForStage('done')).toBe(REACTION_DONE);
  expect(REACTION_WORKING).toBe('👀');
  expect(REACTION_STALLED).toBe('😴');
  expect(REACTION_DONE).toBe('👌');
});

test('isAllowedReaction: known-good and known-bad', () => {
  expect(isAllowedReaction('👀')).toBe(true);
  expect(isAllowedReaction('😴')).toBe(true);
  expect(isAllowedReaction('👌')).toBe(true);
  expect(isAllowedReaction('⏳')).toBe(false);
  expect(isAllowedReaction('✅')).toBe(false);
  expect(ALLOWED_REACTIONS.size).toBeGreaterThan(50);
});

test('doneReactionForSend: flips only on --tag answer with a reply target', () => {
  expect(doneReactionForSend({ tag: 'answer', replyToMessageId: 42 })).toEqual({ messageId: 42, emoji: REACTION_DONE });
  expect(doneReactionForSend({ tag: 'answer', replyToMessageId: null })).toBeNull();
  expect(doneReactionForSend({ tag: 'report', replyToMessageId: 42 })).toBeNull();
  expect(doneReactionForSend({ replyToMessageId: 42 })).toBeNull();
  expect(doneReactionForSend({ tag: 'answer' })).toBeNull();
});

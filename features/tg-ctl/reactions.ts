// Reaction lifecycle on inbound messages (tg-cli#114).
//
// The daemon already sets a static 👀 delivery receipt (spec §10). Alex asked
// (tg#5699) for the receipt to reflect the agent's LIVE state: an hourglass when
// a message's agent is stalled on limits, back to eyes on resume, and a check
// when the message is answered or a task is filed for it.
//
// Telegram constraint (VERIFIED live via setMessageReaction, tg-cli#114): the
// literal ⏳ and ✅ Alex named are BOTH REACTION_INVALID — a bot may only react
// with emoji in the free reaction set. Alex explicitly allowed "или что-то
// подобное" (or something similar), so the intended emoji map to the closest
// ALLOWED members: ⏳ → 😴 (sleeping = stalled/waiting), ✅ → 👌 (ok/done). 👀
// (working) is already allowed and unchanged.
//
// This module is PURE: it decides WHICH emoji a lifecycle stage uses and whether
// a send should flip a reaction. The daemon / `tg` entrypoint owns the actual
// setMessageReaction call (which fails open, per the existing helper).

export type ReactionStage = 'working' | 'stalled' | 'done';

// The emoji actually sent per stage — every one is in ALLOWED_REACTIONS.
export const REACTION_WORKING = '👀'; // seen / being worked (the existing receipt)
export const REACTION_STALLED = '😴'; // agent stopped on limits (intended: ⏳)
export const REACTION_DONE = '👌'; // answered / task filed (intended: ✅)

// What Alex literally asked for, kept for documentation + the mapping test. These
// are NOT sent (Telegram rejects them); REACTION_* above are their allowed proxies.
export const INTENDED_REACTIONS: Readonly<Record<'stalled' | 'done', string>> = { stalled: '⏳', done: '✅' };

// The Bot API free-reaction set a bot may use with setMessageReaction (regular,
// non-premium reactions). Data, not logic — used to guarantee every stage emoji
// is send-safe and to let the daemon skip a call that would 400 REACTION_INVALID.
export const ALLOWED_REACTIONS: ReadonlySet<string> = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮',
  '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡',
  '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻',
  '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '✍️', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪',
  '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
]);

export function reactionForStage(stage: ReactionStage): string {
  switch (stage) {
    case 'working':
      return REACTION_WORKING;
    case 'stalled':
      return REACTION_STALLED;
    case 'done':
      return REACTION_DONE;
  }
}

// True iff a bot may send this emoji as a reaction. The daemon uses it to skip an
// unsupported emoji instead of wasting an API round-trip on a guaranteed reject.
export function isAllowedReaction(emoji: string): boolean {
  return ALLOWED_REACTIONS.has(emoji);
}

// Decide whether an outbound `tg` send should flip a message's reaction to DONE.
// Alex (#114): a send with `--tag answer --reply-to <id>` marks message <id>
// answered. Returns the {messageId, emoji} to react with, or null when the send
// is not a terminal answer to a specific message.
export function doneReactionForSend(opts: { tag?: string | null; replyToMessageId?: number | null }): { messageId: number; emoji: string } | null {
  if (opts.tag !== 'answer') return null;
  if (opts.replyToMessageId == null) return null;
  return { messageId: opts.replyToMessageId, emoji: REACTION_DONE };
}

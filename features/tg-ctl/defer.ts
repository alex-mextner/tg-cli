// Defer-while-waiting queue model for the tg-ctl daemon (spec tg#30).
//
// THE DANGER this exists to prevent: tg-ctl injects inbound Telegram messages
// into the agent's tmux pane via `send-keys`. If a question/permission prompt is
// OPEN in that pane, injected text is typed INTO the prompt — lost, or worse,
// corrupting the user's answer. So while a pane has a pending question the daemon
// QUEUES inbound text here instead of blasting it into the pane, and flushes the
// queue once the question is answered (button reply → flush).
//
// PURE: no I/O. The daemon owns tmux spawns and the pendingButtons map; it feeds
// this model the live pane-busy state and an inject callback.
//
// Past bug (the reason driveFlush re-checks PER ITEM): the agent very often opens
// a SECOND question the instant the first is answered. A flush that drained the
// whole queue up-front and pasted without re-checking would type the queued text
// straight into the new prompt — re-introducing the exact hanging-question bug.
// driveFlush therefore consults isPaneBusy() before EACH paste and re-defers the
// untouched tail the moment a new question appears.

// Per-pane FIFO queues of already-wrapped inbound texts awaiting their pane's
// open question to be answered. Keyed by tmux pane id ("%N").
export class DeferQueues<T = string> {
  private readonly byPane = new Map<string, T[]>();

  // Append one item to the back of a pane's queue.
  enqueue(paneId: string, item: T): void {
    const q = this.byPane.get(paneId);
    if (q) q.push(item);
    else this.byPane.set(paneId, [item]);
  }

  has(paneId: string): boolean {
    return (this.byPane.get(paneId)?.length ?? 0) > 0;
  }

  // Every pane that currently holds a non-empty backlog. Used to dead-letter the
  // strays behind an UNSCOPED question on its abandon: an unscoped question (no
  // paneId) defers inbound for ANY pane, so its backlog can sit on several panes
  // at once and there is no single pane key to dead-letter (tg-cli#58). The caller
  // sweeps each returned pane through the same per-pane abandon guard.
  panesWithBacklog(): string[] {
    const panes: string[] = [];
    for (const [pane, q] of this.byPane) if (q.length > 0) panes.push(pane);
    return panes;
  }

  // Read-only view of a pane's queue (tests; never mutate the result).
  peek(paneId: string): readonly T[] {
    return this.byPane.get(paneId) ?? [];
  }

  // Drain a pane's queue for a flush attempt and remove the entry. The caller
  // runs driveFlush on the result and re-defers whatever it could not inject.
  take(paneId: string): T[] {
    const q = this.byPane.get(paneId);
    if (!q) return [];
    this.byPane.delete(paneId);
    return q;
  }

  // Put un-flushed items back at the FRONT, ahead of anything that arrived for
  // this pane while the flush was in flight — so the user's ordering survives a
  // re-defer (the tail of an interrupted flush precedes newer messages).
  redefer(paneId: string, items: T[]): void {
    if (items.length === 0) return;
    const later = this.byPane.get(paneId) ?? [];
    this.byPane.set(paneId, [...items, ...later]);
  }

  // Drop a pane's whole queue and return what was dropped. Used to dead-letter a
  // backlog when its question is removed WITHOUT an answer: leaving it would let
  // those messages resurface, stale and out of order, on a LATER unrelated
  // question's flush. The caller tells the user (the messages never reached the
  // agent) rather than silently losing them.
  drop(paneId: string): T[] {
    return this.take(paneId);
  }
}

// Drive a queue flush, re-checking the pane between EVERY item via isPaneBusy().
// The check matters because the daemon awaits the actual tmux paste between
// items, and a freshly-answered question is commonly followed by another one:
// the first injection unblocks the agent, which may immediately re-prompt. The
// moment isPaneBusy() reports a new open question, the loop STOPS and hands the
// untouched tail back to the caller to re-defer — that tail flushes when THAT
// question is answered, so nothing is ever pasted into an open prompt.
//
// A new-question abort is the ONLY reason to re-defer. An inject FAILURE (pane no
// longer hosts an agent, a tmux error) must NOT re-defer the tail: there is no
// pending question to flush it later, so re-deferring would wedge every following
// message in memory forever, marked "queued", while the user thinks it landed
// (review finding — head-of-line blocking + indefinite stuck). On failure we log
// (via the inject callback) and SKIP that one item, continuing with the rest —
// the same forward-progress the pre-defer loop had.
//
// The concurrent-flush hazard `isAbandoned` closes: a follow-up question can open
// on this pane DURING the flush — newer inbound defers behind it (FIFO) — and then
// be abandoned (hook timeout / socket close / send failure) with NO terminal
// answer. The agent is still blocked locally on that prompt, but isPaneBusy() now
// reports idle (the pending button is gone). Without this signal the loop would
// paste that orphaned tail straight into the still-open prompt — the very "stale
// resurface" this module exists to kill, on the concurrent-flush path. The daemon
// sets the flag in onQuestionAbandoned and the loop, seeing it, returns the
// untouched tail as `abandoned` so the caller DEAD-LETTERS it (never pastes,
// never re-defers — there is no future answer to flush it).
//
// PURE control flow: all I/O (isPaneBusy, isAbandoned, inject) is injected, so
// tests drive it with plain callbacks and assert exactly which items landed vs
// were re-deferred vs dead-lettered.
//
// Residual race (same bounded window isPaneBusy already lives with): both guards
// are read BEFORE each inject(). If a question opens or is abandoned DURING the
// awaited paste of the current item, that one item still lands; the guard only
// protects the items AFTER it. The daemon mutates this state from event-loop
// callbacks (button-answer / socket-close), which cannot preempt a synchronous
// guard read, so the window is exactly one in-flight paste — accepted, not closed,
// because no observable bridge signal marks the boundary inside a single paste.
export interface FlushOutcome<T = string> {
  injected: T[];
  failed: T[]; // attempted but inject() returned false (logged, dropped)
  reDeferred: T[]; // a new question opened — flush these on its answer
  abandoned: T[]; // a question was abandoned mid-flush — dead-letter these
}

export async function driveFlush<T = string>(
  queue: readonly T[],
  isPaneBusy: () => boolean,
  inject: (item: T) => Promise<boolean>,
  isAbandoned: () => boolean = () => false,
): Promise<FlushOutcome<T>> {
  const injected: T[] = [];
  const failed: T[] = [];
  // Both guards are RE-READ at the top of every iteration (not cached once): the
  // daemon mutates the underlying state from event-loop callbacks between the
  // awaited pastes, so a flag that flips mid-flush must be observed on the next
  // item. A "cache the flag once" optimization would silently break that.
  for (let i = 0; i < queue.length; i++) {
    // A question was abandoned mid-flush → stop and label the untouched tail
    // `abandoned`. Checked before isPaneBusy because the two can race and the
    // resolution differs: abandoned messages have no answer of their own coming.
    // driveFlush does NOT itself decide dead-letter vs re-defer — it only marks the
    // tail; the caller chooses (dead-letter if the pane is idle, re-defer if a
    // DIFFERENT question is still live and will flush the queue on its answer).
    if (isAbandoned()) return { injected, failed, reDeferred: [], abandoned: queue.slice(i) };
    // A new question opened → stop and re-defer everything not yet attempted.
    if (isPaneBusy()) return { injected, failed, reDeferred: queue.slice(i), abandoned: [] };
    if (await inject(queue[i])) injected.push(queue[i]);
    else failed.push(queue[i]); // pane gone / tmux error — drop, don't wedge
  }
  return { injected, failed, reDeferred: [], abandoned: [] };
}

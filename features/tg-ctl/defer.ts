// Defer-while-waiting queue model for the tg-ctl daemon (spec tg#30).
//
// THE DANGER this exists to prevent: tg-ctl injects inbound Telegram messages
// into the agent's tmux pane via `send-keys`. If a question/permission prompt is
// OPEN in that pane, injected text is typed INTO the prompt — lost, or worse,
// corrupting the user's answer. So while a pane has a pending question the daemon
// QUEUES inbound text here instead of blasting it into the pane, and flushes the
// queue once the question is answered or released (button reply, terminal
// fallback, timeout/socket close).
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

  // Every pane that currently holds a non-empty backlog. Used to release the
  // strays behind an UNSCOPED question: an unscoped question (no paneId) defers
  // inbound for ANY pane, so its backlog can sit on several panes at once.
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

  // A snapshot of every pane holding a non-empty backlog, as [paneId, items]
  // entries in insertion order. The daemon persists this to disk (deferred-store)
  // on mutation so a `tg-ctl restart` / launchd reload doesn't drop queued
  // messages. Item arrays are copied so a later mutation can't alias the snapshot.
  snapshot(): Array<[string, T[]]> {
    const out: Array<[string, T[]]> = [];
    for (const [pane, q] of this.byPane) if (q.length > 0) out.push([pane, [...q]]);
    return out;
  }

  // Rebuild the per-pane queues from a snapshot (daemon startup, after a reload).
  // Empty item lists are skipped so a restore never resurrects an empty backlog.
  // Copies each list so the restored queue owns its own array.
  restore(entries: Array<[string, T[]]>): void {
    for (const [pane, items] of entries) {
      if (items.length === 0) continue;
      this.byPane.set(pane, [...items]);
    }
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
// PURE control flow: all I/O (isPaneBusy, inject) is injected, so tests drive it
// with plain callbacks and assert exactly which items landed vs were re-deferred.
//
// Residual race (same bounded window isPaneBusy already lives with): the busy
// guard is read BEFORE each inject(). If a question opens DURING the awaited paste
// of the current item, that one item still lands; the guard only protects the
// items AFTER it. The daemon mutates this state from event-loop
// callbacks (button-answer / socket-close), which cannot preempt a synchronous
// guard read, so the window is exactly one in-flight paste — accepted, not closed,
// because no observable bridge signal marks the boundary inside a single paste.
export interface FlushOutcome<T = string> {
  injected: T[];
  failed: T[]; // attempted but inject() returned false (logged, dropped)
  reDeferred: T[]; // a new question opened — flush these on its answer
}

export async function driveFlush<T = string>(
  queue: readonly T[],
  isPaneBusy: () => boolean,
  inject: (item: T) => Promise<boolean>,
): Promise<FlushOutcome<T>> {
  const injected: T[] = [];
  const failed: T[] = [];
  // isPaneBusy is RE-READ at the top of every iteration (not cached once): the
  // daemon mutates pane-question state from event-loop callbacks between the
  // awaited pastes, so a question that opens mid-flush must be observed on the
  // next item. A "cache the flag once" optimization would silently break that.
  for (let i = 0; i < queue.length; i++) {
    // A new question opened → stop and re-defer everything not yet attempted.
    if (isPaneBusy()) return { injected, failed, reDeferred: queue.slice(i) };
    if (await inject(queue[i])) injected.push(queue[i]);
    else failed.push(queue[i]); // pane gone / tmux error — drop, don't wedge
  }
  return { injected, failed, reDeferred: [] };
}

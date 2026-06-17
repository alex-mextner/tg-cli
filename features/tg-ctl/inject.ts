// tmux injection plans (spec §5.2, §16 module 5).
//
// PURE — these functions return InjectStep[] data; the tg-ctl entrypoint
// executes the steps (spawnSync tmux, Bun.sleep, pane re-verification).
// The recipe is the live-proven one: literal send-keys for single lines,
// bracketed paste via load-buffer/paste-buffer for multi-line, and a paced
// SEPARATE Enter at the end.

import type { InjectStep } from './types';

// {name}/{msg}/{id} substitution in a single pass over the TEMPLATE only, so
// placeholder-looking text inside the substituted values is never expanded
// (replacement output is not rescanned).
//
// `{id}` carries the inbound Telegram message_id so the agent reading its pane
// knows the id to pass to `tg --reply-to <id>` (threaded replies). It renders as
// `tg#<id>` (the `tg#` prefix is part of the substitution, NOT the template):
// this is the message-ref convention (tg#28). The `tg#` — not a bare `#` — is
// what lets the outbound autolink layer recognize a reply-to-a-message reference
// and keep it distinct from a GitHub issue/PR `#<id>` (which would otherwise be
// resolved against the cwd repo and mis-linked). When no id is available (a
// /agent route, a media item, …) the `{id}` placeholder is removed from the
// TEMPLATE along with one adjacent space BEFORE substitution, so the wrap reads
// naturally (`[TG from {name} {id}]` → `[TG from {name}]`). Doing the cleanup on
// the template — never on the substituted output — is what keeps the user's
// message intact: a `{msg}` containing double spaces or a ` : ` ratio must come
// through verbatim and must NOT be collapsed (codex review finding).
export function wrapInbound(template: string, name: string, msg: string, messageId?: number): string {
  // No id → strip the `{id}` token (and one neighbouring space) from the
  // template first; with an id, substitute it as `#<id>` in place.
  const prepared =
    messageId === undefined ? template.replace(/ ?\{id\} ?/g, (m) => (/^ .* $/.test(m) ? ' ' : '')) : template;
  return prepared.replace(/\{name\}|\{msg\}|\{id\}/g, (m) => {
    if (m === '{name}') return name;
    if (m === '{msg}') return msg;
    return messageId !== undefined ? `tg#${messageId}` : '';
  });
}

export interface TextInjectOpts {
  escapePrelude?: boolean; // send Escape first (close pickers/menus before typing)
  gapMs?: number; // pre-Enter gap (default 500ms — competitor-source-proven pacing)
}

export function buildTextInjectPlan(paneId: string, text: string, opts: TextInjectOpts = {}): InjectStep[] {
  const steps: InjectStep[] = [{ kind: 'verify-pane', paneId }];

  if (opts.escapePrelude) {
    steps.push({ kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, 'Escape'] });
    steps.push({ kind: 'sleep', ms: 200 });
  }

  if (text.includes('\n')) {
    // Bracketed paste — the universally safe multi-line path. A literal
    // send-keys LF submits early in canonical-mode REPLs; -p keeps the whole
    // payload as one paste event, -d drops the buffer after use.
    steps.push({ kind: 'tmux', argv: ['tmux', 'load-buffer', '-'], stdin: text });
    steps.push({ kind: 'tmux', argv: ['tmux', 'paste-buffer', '-p', '-d', '-t', paneId] });
  } else {
    // -l = literal mode: no key-name interpretation, special-char safe.
    steps.push({ kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, '-l', text] });
  }

  // Enter MUST be a separate send-keys after a real gap — a combined or
  // too-fast Enter is dropped by the Ink TUI (spec §5.2: the single most
  // common failure mode in other tmux-injecting bots).
  steps.push({ kind: 'sleep', ms: opts.gapMs ?? 500 });
  steps.push({ kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, 'Enter'] });
  return steps;
}

// Control verbs are raw key names — NO -l, tmux must interpret them.
export function buildKeyInjectPlan(paneId: string, key: 'Escape'): InjectStep[] {
  return [
    { kind: 'verify-pane', paneId },
    { kind: 'tmux', argv: ['tmux', 'send-keys', '-t', paneId, key] },
  ];
}

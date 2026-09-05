// The `pre-send-text` sibling of run-photo-hooks.ts's `pre-send-photo` wiring.
//
// Same agents-hooks/v1 framework, same non-breaking seam contract (guarded by
// ONE `stat ~/.agents/hooks/tg/` — hooksActive — before this module does any
// work): no descriptors under the point → byte-identical to before this
// feature. Fires for every TEXT send (not just photo captions), so a plain
// `tg "msg"` now reaches the hook framework too, where the photo point never
// did. See tg's pre-send-text seam (right before `transmit(plan, transport)`)
// for where this is wired.
import { homedir } from 'os';
import { HOOK_API, type HookEvent, type HooksVerdict } from './types';
import { buildRunnerDeps, loadDescriptors, TOOL } from './run-photo-hooks';
import { freshEventId, runHooks } from './runner';

export interface TextHookInput {
  // The fully-assembled message body about to be sent (post render/autolink,
  // pre-transmit) — the same text a recipient will actually read.
  body: string;
  // The `--tag` value, if any (e.g. "decision"). Absent for an untagged
  // send. The escalation-format gate only acts on decision;
  // other hooks are free to ignore this field.
  tag?: string;
  chatId?: string;
}

// Run the pre-send-text point for ONE outbound message. Returns the aggregate
// verdict; the caller (tg seam) acts on `blocked`.
export function runPreSendTextHooks(
  input: TextHookInput,
  env: NodeJS.ProcessEnv,
  home = homedir(),
): HooksVerdict {
  const loaded = loadDescriptors('pre-send-text', home);
  if (loaded.length === 0) {
    return { blocked: false, results: [] };
  }
  const deps = buildRunnerDeps(env, home);
  const buildEvent = (): HookEvent => ({
    hook_api: HOOK_API,
    event_id: freshEventId(),
    tool: TOOL,
    point: 'pre-send-text',
    command: 'send-text',
    cwd: process.cwd(),
    args: {
      body: input.body,
      tag: input.tag ?? '',
      chat_id: input.chatId ?? '',
    },
  });
  return runHooks(loaded, buildEvent, deps);
}

// Convenience for the tg seam: gate one assembled text body. Empty/whitespace
// bodies are skipped — there is nothing for a hook to inspect (mirrors
// gatePhotos skipping a non-existent disk path).
export interface TextGateResult {
  blocked: boolean;
  message?: string;
}

export function gateText(
  body: string,
  ctx: { tag?: string; chatId?: string },
  env: NodeJS.ProcessEnv,
  home = homedir(),
): TextGateResult {
  if (!body.trim()) return { blocked: false };
  const verdict = runPreSendTextHooks({ body, tag: ctx.tag, chatId: ctx.chatId }, env, home);
  if (verdict.blocked) return { blocked: true, message: verdict.blockMessage };
  return { blocked: false };
}

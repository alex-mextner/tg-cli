// Telegram inline-button model for agent questions and permission prompts.
//
// This module is pure: the daemon owns sendMessage, editMessageText,
// answerCallbackQuery, hook sockets, and native adapter I/O.

import type { AgentKind, Registration } from './types';

export type ButtonRequestKind = 'question' | 'permission';
export type QuestionCapability = 'buttons' | 'unsupported';
export type PermissionDecision = 'allow' | 'deny';

export interface ButtonOption {
  label: string;
  description?: string;
}

// Custom wording for a permission-kind request's two buttons. Defaults to
// Approve/Reject; a plan-approval (ExitPlanMode) overrides to Proceed/Keep
// planning so the tap reads correctly while the routed decision stays allow/deny.
export interface DecisionLabels {
  allow: string;
  deny: string;
}

export interface OpencodeRequestRef {
  sessionId: string;
  requestId: string;
  replyKind: 'question' | 'question-v2' | 'permission' | 'permission-v2';
}

export interface ButtonRequest {
  requestId: string;
  buttonId?: string; // short Telegram callback id; requestId may be long/opaque
  paneId?: string;
  cwd?: string;
  sessionName?: string;
  agent: AgentKind;
  kind: ButtonRequestKind;
  question: string;
  title?: string;
  options?: ButtonOption[];
  // Permission-kind only: relabel the allow/deny buttons (e.g. plan-approval →
  // Proceed/Keep planning). The decision routed back is unchanged (allow/deny).
  decisionLabels?: DecisionLabels;
  // Permission-kind only: which Claude Code hook event this came from. The two
  // events take DIFFERENT output shapes (PreToolUse → permissionDecision;
  // PermissionRequest → decision.behavior), so the hook reply must match the
  // event that fired. Defaults to PermissionRequest (the `*` matcher we install).
  permissionEvent?: 'PreToolUse' | 'PermissionRequest';
  // Permission-kind only: the tool's original `tool_input`, carried so a PreToolUse
  // ExitPlanMode ALLOW can echo it back as `updatedInput`. The live hooks docs
  // require allow + updatedInput for the user-interactive tools ("allow alone is
  // not sufficient"); echoing the unchanged input is the documented round trip.
  // (AskUserQuestion is a question-kind request and builds its own questions/answers
  // updatedInput in the question branch — it never reads this field.)
  toolInput?: Record<string, unknown>;
  opencode?: OpencodeRequestRef;
}

export interface ButtonMessagePayload {
  chat_id: number;
  text: string;
  reply_markup: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

export interface ParsedButtonCallback {
  requestId: string;
  value: string;
}

export type ButtonAnswer =
  | {
      status: 'answered';
      requestId: string;
      label: string;
      value: string;
      decision?: PermissionDecision;
    }
  | { status: 'unsupported'; requestId: string; reason: string };

const CALLBACK_PREFIX = 'tgq';

// Registration guard for incoming hook requests. paneId is authoritative: when
// both sides know the pane, a mismatch REJECTS even if cwd/sessionName agree —
// a second keyboard session in the same cwd must never block on Telegram.
// cwd comparison is the caller's job (path normalization needs node:path);
// pass both already-resolved.
export function registrationAllowsHook(
  reg: Registration | null,
  req: Pick<ButtonRequest, 'paneId' | 'cwd' | 'sessionName'>,
  resolvePath: (p: string) => string = (p) => p,
): boolean {
  if (!reg) return false;
  if (req.paneId && reg.paneId) return req.paneId === reg.paneId;
  if (req.cwd && reg.cwd && resolvePath(req.cwd) === resolvePath(reg.cwd)) return true;
  if (req.sessionName && reg.sessionName && req.sessionName === reg.sessionName) return true;
  return false;
}

export function questionCapability(agent: AgentKind): QuestionCapability {
  if (agent === 'claude' || agent === 'codex' || agent === 'opencode') return 'buttons';
  return 'unsupported';
}

export function buildButtonMessage(chatId: number, req: ButtonRequest): ButtonMessagePayload {
  const heading = req.kind === 'permission'
    ? `Permission request from ${req.agent}`
    : `Question from ${req.agent}`;
  const parts = [heading];
  if (req.title) parts.push(req.title);
  parts.push(req.question);

  return {
    chat_id: chatId,
    text: parts.join('\n\n'),
    reply_markup: {
      inline_keyboard: buildInlineKeyboard(req),
    },
  };
}

export function parseButtonCallback(data: string | undefined): ParsedButtonCallback | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX || !parts[1] || !parts[2]) return null;
  return { requestId: parts[1], value: parts[2] };
}

export function resolveButtonCallback(req: ButtonRequest, cb: ParsedButtonCallback): ButtonAnswer {
  if (cb.requestId !== callbackRequestId(req)) {
    return { status: 'unsupported', requestId: req.requestId, reason: 'callback request mismatch' };
  }

  if (req.kind === 'permission') {
    const labels = permissionLabels(req);
    if (cb.value === 'allow') {
      return { status: 'answered', requestId: req.requestId, label: labels.allow, value: 'allow', decision: 'allow' };
    }
    if (cb.value === 'deny') {
      return { status: 'answered', requestId: req.requestId, label: labels.deny, value: 'deny', decision: 'deny' };
    }
    return { status: 'unsupported', requestId: req.requestId, reason: 'unknown permission button' };
  }

  const match = cb.value.match(/^o(\d+)$/);
  const index = match ? Number(match[1]) : -1;
  const option = questionOptions(req)[index];
  if (!option) return { status: 'unsupported', requestId: req.requestId, reason: 'unknown question option' };
  return {
    status: 'answered',
    requestId: req.requestId,
    label: option.label,
    value: option.label,
  };
}

export function formatAgentHookOutput(req: ButtonRequest, answer: ButtonAnswer): unknown | null {
  if (answer.status !== 'answered') return null;

  if (req.agent === 'claude' && req.kind === 'question') {
    return {
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: {
          questions: [
            {
              header: req.title,
              question: req.question,
              options: req.options ?? [],
            },
          ],
          answers: {
            [req.question]: answer.value,
          },
        },
      },
    };
  }

  if (req.agent === 'claude' && req.kind === 'permission') {
    const behavior = answer.decision ?? decisionFromValue(answer.value);
    // On a RELABELED deny (plan-approval → "Keep planning"), convey the tapped
    // label as the reason so the model gets the INTENT, not an unexplained block
    // (a bare deny on ExitPlanMode can leave it re-prompting or looping). A plain
    // Approve/Reject deny carries no extra reason (the default "Reject" is noise).
    const denyReason = behavior === 'deny' && req.decisionLabels ? answer.label : undefined;

    // PreToolUse output (hookEventName REQUIRED): permissionDecision, with the deny
    // reason in the event's own `permissionDecisionReason`. For an ALLOW the live
    // hooks docs require `updatedInput` ALONGSIDE allow for the user-interactive
    // tools (ExitPlanMode / AskUserQuestion): "Returning allow alone is not
    // sufficient for these tools." Echo the unchanged `tool_input` back so the tool
    // runs without falling through to the local permission prompt.
    if (req.permissionEvent === 'PreToolUse') {
      const out: Record<string, unknown> = { hookEventName: 'PreToolUse', permissionDecision: behavior };
      if (behavior === 'allow' && req.toolInput) out.updatedInput = req.toolInput;
      if (denyReason) out.permissionDecisionReason = denyReason;
      return { hookSpecificOutput: out };
    }
    // PermissionRequest output (hookEventName REQUIRED). The `decision` object has a
    // `message` field documented "for deny only: tells Claude why the permission was
    // denied" (live hooks reference, PermissionRequest decision control). That is the
    // MODEL-facing reason channel — distinct from top-level `systemMessage`, which is
    // "shown to the user" only. On a RELABELED deny (plan-approval → "Keep planning")
    // the intent must reach Claude so it resumes planning rather than re-prompting on
    // an unexplained block, so the tapped label rides `decision.message`. A bare allow
    // needs no `updatedInput` echo (it is optional for a permission we never modify).
    const decision: Record<string, unknown> = { behavior };
    if (denyReason) decision.message = denyReason;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }

  if (req.agent === 'codex' && req.kind === 'permission') {
    const behavior = answer.decision ?? decisionFromValue(answer.value);
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: behavior === 'deny'
          ? { behavior, message: 'Rejected from Telegram' }
          : { behavior },
      },
    };
  }

  if (req.agent === 'opencode') {
    return { answer: answer.value };
  }

  return null;
}

// Allow/deny button wording for a permission request: a plan-approval relabels
// the pair (Proceed/Keep planning); everything else stays Approve/Reject.
function permissionLabels(req: ButtonRequest): DecisionLabels {
  return req.decisionLabels ?? { allow: 'Approve', deny: 'Reject' };
}

function buildInlineKeyboard(req: ButtonRequest): ButtonMessagePayload['reply_markup']['inline_keyboard'] {
  if (req.kind === 'permission') {
    const labels = permissionLabels(req);
    return [[
      { text: labels.allow, callback_data: callbackData(callbackRequestId(req), 'allow') },
      { text: labels.deny, callback_data: callbackData(callbackRequestId(req), 'deny') },
    ]];
  }

  return questionOptions(req).map((option, index) => [
    { text: option.label, callback_data: callbackData(callbackRequestId(req), `o${index}`) },
  ]);
}

function questionOptions(req: ButtonRequest): ButtonOption[] {
  return req.options?.length ? req.options : [{ label: 'OK' }];
}

export function callbackRequestId(req: ButtonRequest): string {
  if (req.buttonId && /^[A-Za-z0-9_-]{1,40}$/.test(req.buttonId)) return req.buttonId;
  if (/^[A-Za-z0-9_-]{1,40}$/.test(req.requestId)) return req.requestId;
  return `b${hashId(req.requestId)}`;
}

function callbackData(requestId: string, value: string): string {
  return `${CALLBACK_PREFIX}:${requestId}:${value}`;
}

function hashId(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

function decisionFromValue(value: string): PermissionDecision {
  return value === 'deny' ? 'deny' : 'allow';
}

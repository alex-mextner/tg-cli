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
    if (cb.value === 'allow') {
      return { status: 'answered', requestId: req.requestId, label: 'Approve', value: 'allow', decision: 'allow' };
    }
    if (cb.value === 'deny') {
      return { status: 'answered', requestId: req.requestId, label: 'Reject', value: 'deny', decision: 'deny' };
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
    return {
      hookSpecificOutput: {
        decision: {
          behavior: answer.decision ?? decisionFromValue(answer.value),
        },
      },
    };
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

function buildInlineKeyboard(req: ButtonRequest): ButtonMessagePayload['reply_markup']['inline_keyboard'] {
  if (req.kind === 'permission') {
    return [[
      { text: 'Approve', callback_data: callbackData(callbackRequestId(req), 'allow') },
      { text: 'Reject', callback_data: callbackData(callbackRequestId(req), 'deny') },
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

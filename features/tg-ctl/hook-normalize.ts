// Normalize a RAW harness hook payload into a ButtonRequest the daemon
// understands (q→buttons, docs/specs/2026-06-10-tg-ctl-control-design.md §8).
//
// The installed hook command is just `tg-ctl ask` (optionally `--agent codex`),
// so the agent's harness pipes its native hook JSON straight in — this module
// turns that into the normalized request, using the hook process's own
// environment (TMUX_PANE / cwd / tmux session) for the routing fields. PURE: the
// entrypoint reads stdin + env and calls in here.
//
// Supported today: Claude Code PreToolUse `AskUserQuestion` (single,
// non-multiSelect, concrete options), Claude Code PreToolUse `ExitPlanMode`
// (plan-approval — a harness BLOCKING prompt mirrored as Proceed/Keep planning
// buttons; ROADMAP "Forward harness confirmation / permission prompts to TG"),
// and Claude Code / Codex `PermissionRequest`. Anything else returns null → the
// hook emits nothing and the local agent UI takes over (multi-question /
// multiSelect / free-form fall back on purpose).

import type { AgentKind } from './types';
import type { ButtonOption, ButtonRequest, ButtonRequestKind, DecisionLabels } from './questions';

export interface HookEnv {
  agent: AgentKind; // from the --agent flag the installer wrote (default claude)
  paneId?: string; // process.env.TMUX_PANE of the hook process
  cwd?: string; // hook process cwd (payload.cwd wins when present)
  sessionName?: string; // tmux session of the pane
}

// djb2 — a short stable id so a repeated identical prompt reuses its callback key.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

// Validate a client-supplied decisionLabels object: both labels must be present
// non-empty strings, else fall back to the default Approve/Reject (undefined).
function readDecisionLabels(raw: unknown): DecisionLabels | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const allow = typeof rec.allow === 'string' ? rec.allow : '';
  const deny = typeof rec.deny === 'string' ? rec.deny : '';
  return allow && deny ? { allow, deny } : undefined;
}

function readOptions(raw: unknown): ButtonOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ButtonOption[] = [];
  for (const o of raw) {
    const rec = asRecord(o);
    const label = rec && typeof rec.label === 'string' ? rec.label : null;
    if (!label) continue;
    const description = rec && typeof rec.description === 'string' ? rec.description : undefined;
    out.push(description ? { label, description } : { label });
  }
  return out.length ? out : null;
}

// Build a ButtonRequest from an already-known field set, folding in the env.
function build(
  env: HookEnv,
  kind: ButtonRequestKind,
  idSeed: string,
  question: string,
  title: string | undefined,
  options: ButtonOption[] | undefined,
  cwd: string | undefined,
): ButtonRequest {
  return {
    requestId: `${env.agent}-${hash(idSeed)}`,
    agent: env.agent,
    kind,
    question,
    title,
    options,
    paneId: env.paneId,
    cwd: cwd ?? env.cwd,
    sessionName: env.sessionName,
  };
}

export function normalizeHookPayload(payload: unknown, env: HookEnv): ButtonRequest | null {
  const p = asRecord(payload);
  if (!p) return null;

  // Already a normalized ButtonRequest (back-compat / manual callers): trust its
  // core fields, but let the live env supply any missing routing fields.
  if (typeof p.requestId === 'string' && typeof p.question === 'string' && (p.kind === 'question' || p.kind === 'permission')) {
    return {
      requestId: p.requestId,
      agent: (typeof p.agent === 'string' ? p.agent : env.agent) as AgentKind,
      kind: p.kind,
      question: p.question,
      title: typeof p.title === 'string' ? p.title : undefined,
      options: readOptions(p.options) ?? undefined,
      // Carry the permission-rendering fields through too — a normalized
      // plan-approval must keep its Proceed/Keep-planning labels and its
      // event-correct reply shape, not silently downgrade to Approve/Reject +
      // the default PermissionRequest output.
      decisionLabels: readDecisionLabels(p.decisionLabels),
      permissionEvent: p.permissionEvent === 'PreToolUse' ? 'PreToolUse' : undefined,
      paneId: typeof p.paneId === 'string' ? p.paneId : env.paneId,
      cwd: typeof p.cwd === 'string' ? p.cwd : env.cwd,
      sessionName: typeof p.sessionName === 'string' ? p.sessionName : env.sessionName,
    };
  }

  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  const session = typeof p.session_id === 'string' ? p.session_id.slice(0, 8) : '';
  const input = asRecord(p.tool_input);
  const toolName = typeof p.tool_name === 'string' ? p.tool_name : '';

  // Claude Code AskUserQuestion → a single concrete question with options.
  if (toolName === 'AskUserQuestion' && input) {
    const questions = input.questions;
    if (!Array.isArray(questions) || questions.length !== 1) return null; // multi-question → local UI
    const q = asRecord(questions[0]);
    if (!q || typeof q.question !== 'string') return null;
    if (q.multiSelect === true) return null; // multi-select → local UI (single-tap model)
    const options = readOptions(q.options);
    if (!options) return null; // free-form → local UI
    const title = typeof q.header === 'string' ? q.header : undefined;
    return build(env, 'question', `${session}:q:${q.question}`, q.question, title, options, cwd);
  }

  // ExitPlanMode → plan-approval: a harness BLOCKING prompt ("the plan is ready,
  // proceed?"). It is gated as a tool (PreToolUse / PermissionRequest), but its
  // semantics are proceed-with-this-plan vs keep-planning, not Approve/Reject of a
  // side-effecting command — and its tool_input carries the PLAN TEXT, which the
  // generic permission branch drops. Forward the plan body + relabel the buttons.
  if (toolName === 'ExitPlanMode') {
    // Clamp ONCE and reuse the bounded string for both the message body and the
    // requestId seed: the full plan can be tens of KiB, and hashing/concatenating
    // it would do O(plan) work that is discarded before sending.
    const plan = clampPlan(typeof input?.plan === 'string' ? input.plan.trim() : '');
    const body = plan ? `Proceed with this plan?\n\n${plan}` : 'The plan is ready. Proceed?';
    return {
      requestId: `${env.agent}-${hash(`${session}:plan:${plan}`)}`,
      agent: env.agent,
      kind: 'permission',
      question: body,
      title: 'Plan ready',
      decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
      permissionEvent: permissionEventOf(p),
      paneId: env.paneId,
      cwd: cwd ?? env.cwd,
      sessionName: env.sessionName,
    };
  }

  // PermissionRequest (Claude Code or Codex): allow/deny a tool call.
  if (p.hook_event_name === 'PermissionRequest' || (toolName && p.hook_event_name === undefined && !input?.questions)) {
    if (!toolName) return null;
    const detail = input ? summarizeInput(toolName, input) : '';
    const question = detail ? `Allow ${toolName}? ${detail}` : `Allow ${toolName}?`;
    const req = build(env, 'permission', `${session}:perm:${toolName}:${detail}`, question, toolName, undefined, cwd);
    req.permissionEvent = permissionEventOf(p);
    return req;
  }

  return null;
}

// Bound the plan body so the forwarded prompt stays well inside Telegram's
// 4096-char message limit (the heading + buttons + wrap share that budget). A
// plan over the bound keeps its head and gains a truncation marker — the CTO can
// read the full plan in the pane; the button is for the proceed/keep decision.
const PLAN_MAX = 3000;
function clampPlan(plan: string): string {
  return plan.length > PLAN_MAX ? `${plan.slice(0, PLAN_MAX)}\n… (plan truncated — see the pane)` : plan;
}

// Which Claude Code hook event delivered this permission — the reply shape
// depends on it (PreToolUse → permissionDecision; PermissionRequest →
// decision.behavior). A PreToolUse matcher (e.g. ExitPlanMode) sets
// hook_event_name: 'PreToolUse'; the `*` PermissionRequest matcher sets
// 'PermissionRequest'; an absent field defaults to PermissionRequest (the matcher
// we install, and the pre-existing behavior for Codex-style payloads).
function permissionEventOf(p: Record<string, unknown>): 'PreToolUse' | 'PermissionRequest' {
  return p.hook_event_name === 'PreToolUse' ? 'PreToolUse' : 'PermissionRequest';
}

// A short, safe one-line summary of the tool input for the permission prompt —
// the command for Bash, the path for file tools, else nothing.
function summarizeInput(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string): string | null => (typeof input[k] === 'string' ? (input[k] as string) : null);
  const raw = pick('command') ?? pick('file_path') ?? pick('path') ?? pick('url') ?? '';
  const one = raw.replace(/\s+/g, ' ').trim();
  return one.length > 100 ? `${one.slice(0, 99)}…` : one;
}

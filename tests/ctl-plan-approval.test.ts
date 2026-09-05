// Forward harness BLOCKING plan-approval prompts (Claude Code ExitPlanMode) to
// Telegram as tappable buttons (ROADMAP "Forward harness confirmation /
// permission prompts to TG as inline buttons", extends tg-cli#30).
//
// ExitPlanMode is a PreToolUse/PermissionRequest-gated tool whose tool_input
// carries the PLAN TEXT and whose semantics are "proceed with this plan" vs
// "keep planning" — NOT a generic Approve/Reject of a side-effecting command.
// Before this, it fell into the generic permission branch and rendered as a
// content-less "Allow ExitPlanMode?" with Approve/Reject buttons, losing the
// plan and mislabeling the choice. These tests pin the dedicated handling.

import { expect, test } from 'bun:test';
import { normalizeHookPayload, type HookEnv } from '../features/tg-ctl/hook-normalize';
import { buildButtonMessage, resolveButtonCallback, formatAgentHookOutput } from '../features/tg-ctl/questions';

const env: HookEnv = { agent: 'claude', paneId: '%7', cwd: '/env/cwd', sessionName: 'work', invocationNonce: 'plan-approval-nonce' };

test('ExitPlanMode PreToolUse → plan-approval permission carrying the plan text + proceed/keep labels', () => {
  const req = normalizeHookPayload(
    {
      session_id: 'abcdef123456',
      cwd: '/proj',
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '1. Add the route\n2. Wire the handler\n3. Test it' },
    },
    env,
  );
  expect(req).toMatchObject({
    agent: 'claude',
    kind: 'permission',
    title: 'Plan ready',
    paneId: '%7',
    cwd: '/proj',
    decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
  });
  // The plan body is forwarded, not dropped.
  expect(req!.question).toContain('1. Add the route');
  expect(req!.question).toContain('3. Test it');
});

test('ExitPlanMode with an over-long plan is truncated (Telegram message bound) but keeps the head', () => {
  const big = Array.from({ length: 400 }, (_, i) => `step ${i}`).join('\n');
  const req = normalizeHookPayload(
    { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: big } },
    env,
  );
  expect(req).not.toBeNull();
  expect(req!.question).toContain('step 0');
  expect(req!.question.length).toBeLessThanOrEqual(3600);
  expect(req!.question).toContain('…'); // truncation marker
});

test('ExitPlanMode with no plan text still forwards as a plan-approval (generic prompt)', () => {
  const req = normalizeHookPayload(
    { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {} },
    env,
  );
  expect(req).toMatchObject({ kind: 'permission', title: 'Plan ready', decisionLabels: { allow: 'Proceed', deny: 'Keep planning' } });
});

test('plan-approval renders custom Proceed/Keep planning buttons (not Approve/Reject)', () => {
  const payload = buildButtonMessage(1000, {
    requestId: 'plan_1',
    agent: 'claude',
    kind: 'permission',
    title: 'Plan ready',
    question: 'Proceed with this plan?\n\n1. Do X',
    decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
  });
  expect(payload.text).toContain('Plan ready');
  expect(payload.reply_markup.inline_keyboard).toEqual([
    [
      { text: 'Proceed', callback_data: 'tgq:plan_1:allow' },
      { text: 'Keep planning', callback_data: 'tgq:plan_1:deny' },
    ],
  ]);
});

test('plan-approval still maps allow/deny taps to the permission decision, with the custom label', () => {
  const req = {
    requestId: 'plan_1',
    agent: 'claude' as const,
    kind: 'permission' as const,
    title: 'Plan ready',
    question: 'Proceed with this plan?',
    decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
  };
  expect(resolveButtonCallback(req, { requestId: 'plan_1', value: 'allow' })).toMatchObject({
    status: 'answered',
    label: 'Proceed',
    decision: 'allow',
  });
  expect(resolveButtonCallback(req, { requestId: 'plan_1', value: 'deny' })).toMatchObject({
    status: 'answered',
    label: 'Keep planning',
    decision: 'deny',
  });
});

test('plan-approval allow with no permissionEvent → default PermissionRequest (decision.behavior) shape', () => {
  // No permissionEvent stamped → the back-compat default is PermissionRequest.
  const req = {
    requestId: 'plan_1',
    agent: 'claude' as const,
    kind: 'permission' as const,
    title: 'Plan ready',
    question: 'Proceed with this plan?',
    decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
  };
  const out = formatAgentHookOutput(req, { status: 'answered', requestId: 'plan_1', label: 'Proceed', value: 'allow', decision: 'allow' });
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
});

test('ExitPlanMode arriving via PreToolUse → permissionEvent PreToolUse, allow echoes updatedInput', () => {
  const req = normalizeHookPayload(
    { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'do it' } },
    env,
  );
  expect(req).toMatchObject({ kind: 'permission', permissionEvent: 'PreToolUse', toolInput: { plan: 'do it' } });
  const out = formatAgentHookOutput(req!, { status: 'answered', requestId: req!.requestId, label: 'Proceed', value: 'allow', decision: 'allow' });
  // PreToolUse reply shape — permissionDecision, NOT decision.behavior. ExitPlanMode
  // requires updatedInput ALONGSIDE allow (docs: "allow alone is not sufficient"),
  // so the original tool_input is echoed back unchanged.
  expect(out).toEqual({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { plan: 'do it' } },
  });
});

test('PreToolUse deny carries the tapped label as permissionDecisionReason (keep-planning intent)', () => {
  const req = normalizeHookPayload(
    { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'do it' } },
    env,
  );
  const out = formatAgentHookOutput(req!, { status: 'answered', requestId: req!.requestId, label: 'Keep planning', value: 'deny', decision: 'deny' });
  expect(out).toEqual({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Keep planning' },
  });
});

test('ExitPlanMode arriving via PermissionRequest → permissionEvent PermissionRequest, deny emits decision.behavior shape (production path)', () => {
  const req = normalizeHookPayload(
    { hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: 'do it' } },
    env,
  );
  expect(req).toMatchObject({ kind: 'permission', permissionEvent: 'PermissionRequest' });
  const out = formatAgentHookOutput(req!, { status: 'answered', requestId: req!.requestId, label: 'Keep planning', value: 'deny', decision: 'deny' });
  // The keep-planning intent rides decision.message — the documented MODEL-facing
  // deny reason ("for deny only: tells Claude why the permission was denied"), so
  // Claude resumes planning instead of looping on an unexplained block.
  expect(out).toEqual({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Keep planning' } },
  });
});

test('a plain Claude permission deny (no decisionLabels) carries NO decision.message — unchanged behavior', () => {
  const req = normalizeHookPayload(
    { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } },
    env,
  );
  const out = formatAgentHookOutput(req!, { status: 'answered', requestId: req!.requestId, label: 'Reject', value: 'deny', decision: 'deny' });
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } });
});

test('PreToolUse allow WITHOUT a carried tool_input emits a bare allow (no synthesized updatedInput)', () => {
  // A hand-built / toolInput-less PreToolUse request must not invent updatedInput.
  const req = {
    requestId: 'p_x',
    agent: 'claude' as const,
    kind: 'permission' as const,
    question: 'Proceed?',
    title: 'Plan ready',
    decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
    permissionEvent: 'PreToolUse' as const,
  };
  const out = formatAgentHookOutput(req, { status: 'answered', requestId: 'p_x', label: 'Proceed', value: 'allow', decision: 'allow' });
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
});

test('PreToolUse deny never carries updatedInput (echo is allow-only)', () => {
  const req = normalizeHookPayload(
    { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'do it' } },
    env,
  );
  const out = formatAgentHookOutput(req!, { status: 'answered', requestId: req!.requestId, label: 'Keep planning', value: 'deny', decision: 'deny' });
  expect(out).toEqual({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Keep planning' },
  });
});

test('an already-normalized PreToolUse request round-trips toolInput → updatedInput on allow', () => {
  // Regression for the pass-through branch: a normalized payload carrying toolInput
  // must keep it so a PreToolUse allow still echoes updatedInput.
  const req = normalizeHookPayload(
    {
      requestId: 'r9',
      agent: 'claude',
      kind: 'permission',
      question: 'Proceed with this plan?',
      title: 'Plan ready',
      decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
      permissionEvent: 'PreToolUse',
      toolInput: { plan: 'do it' },
    },
    env,
  );
  expect(req).toMatchObject({ permissionEvent: 'PreToolUse', toolInput: { plan: 'do it' } });
  const out = formatAgentHookOutput(req!, { status: 'answered', requestId: 'r9', label: 'Proceed', value: 'allow', decision: 'allow' });
  expect(out).toEqual({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { plan: 'do it' } },
  });
});

test('a normalized plan-approval request passes through KEEPING decisionLabels + permissionEvent', () => {
  // Regression for the already-normalized branch: these fields must survive the
  // pass-through, else tg-ctl ask downgrades a normalized plan-approval to
  // Approve/Reject + the wrong reply shape.
  const req = normalizeHookPayload(
    {
      requestId: 'r1',
      agent: 'claude',
      kind: 'permission',
      question: 'Proceed with this plan?',
      title: 'Plan ready',
      decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
      permissionEvent: 'PreToolUse',
    },
    env,
  );
  expect(req).toMatchObject({
    requestId: 'r1',
    kind: 'permission',
    decisionLabels: { allow: 'Proceed', deny: 'Keep planning' },
    permissionEvent: 'PreToolUse',
  });
});

test('a normalized request with malformed decisionLabels falls back to undefined (Approve/Reject)', () => {
  // Half-filled / empty labels are dropped — buildButtonMessage then renders the
  // default Approve/Reject rather than a half-broken pair.
  const partial = normalizeHookPayload(
    { requestId: 'r2', agent: 'claude', kind: 'permission', question: 'ok?', decisionLabels: { allow: 'Yes' } },
    env,
  );
  expect((partial as { decisionLabels?: unknown }).decisionLabels).toBeUndefined();
  const empty = normalizeHookPayload(
    { requestId: 'r3', agent: 'claude', kind: 'permission', question: 'ok?', decisionLabels: { allow: '', deny: 'No' } },
    env,
  );
  expect((empty as { decisionLabels?: unknown }).decisionLabels).toBeUndefined();
});

test('a plain Bash PermissionRequest is unaffected — still Approve/Reject, no decisionLabels', () => {
  const req = normalizeHookPayload(
    { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
    env,
  );
  expect(req).toMatchObject({ kind: 'permission', title: 'Bash' });
  expect((req as { decisionLabels?: unknown }).decisionLabels).toBeUndefined();
  const payload = buildButtonMessage(1, req!);
  expect(payload.reply_markup.inline_keyboard[0].map((b) => b.text)).toEqual(['Approve', 'Reject']);
});

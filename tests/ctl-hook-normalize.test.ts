import { expect, test } from 'bun:test';
import { normalizeHookPayload, type HookEnv } from '../features/tg-ctl/hook-normalize';

const env: HookEnv = { agent: 'claude', paneId: '%5', cwd: '/env/cwd', sessionName: 'work' };

test('Claude AskUserQuestion (single, options) → question request', () => {
  const req = normalizeHookPayload(
    {
      session_id: 'abcdef123456',
      cwd: '/proj',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { header: 'Deploy', question: 'Where to deploy?', options: [{ label: 'Staging' }, { label: 'Prod', description: 'live' }] },
        ],
      },
    },
    env,
  );
  expect(req).toMatchObject({
    agent: 'claude',
    kind: 'question',
    question: 'Where to deploy?',
    title: 'Deploy',
    options: [{ label: 'Staging' }, { label: 'Prod', description: 'live' }],
    paneId: '%5',
    cwd: '/proj', // payload cwd wins over env
    sessionName: 'work',
  });
  expect(req!.requestId).toMatch(/^claude-/);
});

test('AskUserQuestion with multiple questions → null (local UI)', () => {
  const req = normalizeHookPayload(
    { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'a', options: [{ label: 'x' }] }, { question: 'b', options: [{ label: 'y' }] }] } },
    env,
  );
  expect(req).toBeNull();
});

test('AskUserQuestion multiSelect → null', () => {
  const req = normalizeHookPayload(
    { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'a', multiSelect: true, options: [{ label: 'x' }] }] } },
    env,
  );
  expect(req).toBeNull();
});

test('AskUserQuestion with no concrete options → null', () => {
  const req = normalizeHookPayload({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'free?' }] } }, env);
  expect(req).toBeNull();
});

test('PermissionRequest → permission with a tool + command summary', () => {
  const req = normalizeHookPayload(
    { session_id: 'sid', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } },
    env,
  );
  expect(req).toMatchObject({ kind: 'permission', title: 'Bash', question: 'Allow Bash? rm -rf /tmp/x', paneId: '%5' });
});

test('Codex PermissionRequest uses the --agent kind', () => {
  const req = normalizeHookPayload(
    { hook_event_name: 'PermissionRequest', tool_name: 'shell', tool_input: { command: 'ls' } },
    { ...env, agent: 'codex' },
  );
  expect(req).toMatchObject({ agent: 'codex', kind: 'permission', question: 'Allow shell? ls' });
});

test('an already-normalized ButtonRequest passes through, env fills missing routing', () => {
  const req = normalizeHookPayload(
    { requestId: 'r1', agent: 'claude', kind: 'question', question: 'q?', options: [{ label: 'ok' }] },
    env,
  );
  expect(req).toMatchObject({ requestId: 'r1', kind: 'question', question: 'q?', paneId: '%5', cwd: '/env/cwd' });
});

test('garbage → null', () => {
  expect(normalizeHookPayload(null, env)).toBeNull();
  expect(normalizeHookPayload({ hook_event_name: 'SessionStart' }, env)).toBeNull();
  expect(normalizeHookPayload('nope', env)).toBeNull();
});

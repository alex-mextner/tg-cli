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

test('AskUserQuestion delivered via the PermissionRequest matcher → null (no double-cover, tg-cli#97)', () => {
  // Claude installs BOTH a PreToolUse:AskUserQuestion matcher AND a
  // PermissionRequest:* catch-all, so an AskUserQuestion fires the hook twice and
  // both copies normalize to the SAME stable requestId. Only the PreToolUse copy
  // forwards; the PermissionRequest-delivered copy must drop so a re-fire after the
  // answer can't post a second, "expired"-reading card.
  const payload = {
    session_id: 'abcdef123456',
    cwd: '/proj',
    hook_event_name: 'PermissionRequest',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{ header: 'Deploy', question: 'Where to deploy?', options: [{ label: 'Staging' }, { label: 'Prod' }] }],
    },
  };
  expect(normalizeHookPayload(payload, env)).toBeNull();

  // The dedicated PreToolUse copy of the very same question still forwards.
  expect(normalizeHookPayload({ ...payload, hook_event_name: 'PreToolUse' }, env)).toMatchObject({
    kind: 'question',
    question: 'Where to deploy?',
  });

  // Back-compat: a payload with NO hook_event_name (manual callers / very old
  // installs that never wrote the event) is NOT the PermissionRequest catch-all,
  // so it must still forward — the drop is strictly the PermissionRequest copy.
  const { hook_event_name, ...noEvent } = payload;
  void hook_event_name;
  expect(normalizeHookPayload(noEvent, env)).toMatchObject({ kind: 'question', question: 'Where to deploy?' });
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

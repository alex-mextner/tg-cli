import { expect, test } from 'bun:test';
import {
  buildButtonMessage,
  formatAgentHookOutput,
  parseButtonCallback,
  questionCapability,
  registrationAllowsHook,
  resolveButtonCallback,
  type ButtonRequest,
} from '../features/tg-ctl/questions';

const QUESTION: ButtonRequest = {
  requestId: 'q_123',
  agent: 'claude',
  kind: 'question',
  title: 'Pick deploy target',
  question: 'Where should I deploy?',
  options: [
    { label: 'Staging', description: 'Safe validation environment' },
    { label: 'Production', description: 'Customer-facing environment' },
  ],
};

test('registrationAllowsHook: paneId match wins, paneId contradiction rejects despite cwd match', () => {
  const reg = { paneId: '%32', cwd: '/proj', sessionName: 'work' };
  expect(registrationAllowsHook(reg, { paneId: '%32' })).toBe(true);
  // A second keyboard session in the SAME cwd but a different pane must
  // fast-pass to the local UI, not block on Telegram.
  expect(registrationAllowsHook(reg, { paneId: '%40', cwd: '/proj' })).toBe(false);
  expect(registrationAllowsHook(reg, { paneId: '%40', sessionName: 'work' })).toBe(false);
});

test('registrationAllowsHook: cwd and sessionName match when paneId is unknown on either side', () => {
  const reg = { paneId: '%32', cwd: '/proj', sessionName: 'work' };
  expect(registrationAllowsHook(reg, { cwd: '/proj' })).toBe(true);
  expect(registrationAllowsHook(reg, { sessionName: 'work' })).toBe(true);
  expect(registrationAllowsHook(reg, { cwd: '/other' })).toBe(false);
  expect(registrationAllowsHook({ cwd: '/proj' }, { paneId: '%40', cwd: '/proj' })).toBe(true);
});

test('registrationAllowsHook: missing registration or no overlapping fields rejects', () => {
  expect(registrationAllowsHook(null, { paneId: '%32' })).toBe(false);
  expect(registrationAllowsHook({}, { paneId: '%32', cwd: '/proj', sessionName: 'work' })).toBe(false);
});

test('registrationAllowsHook: cwd comparison goes through the injected path resolver', () => {
  const reg = { cwd: '/proj/sub/..' };
  const resolver = (p: string) => p.replace('/sub/..', '');
  expect(registrationAllowsHook(reg, { cwd: '/proj' }, resolver)).toBe(true);
});

test('questionCapability is explicit: claude/codex/opencode support buttons, pi is limited', () => {
  expect(questionCapability('claude')).toBe('buttons');
  expect(questionCapability('codex')).toBe('buttons');
  expect(questionCapability('opencode')).toBe('buttons');
  expect(questionCapability('pi')).toBe('unsupported');
});

test('buildButtonMessage renders a question as Telegram inline keyboard payload', () => {
  const payload = buildButtonMessage(1000, QUESTION);
  expect(payload.chat_id).toBe(1000);
  expect(payload.text).toContain('Question from claude');
  expect(payload.text).toContain('Pick deploy target');
  expect(payload.text).toContain('Where should I deploy?');
  expect(payload.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: 'Staging', callback_data: 'tgq:q_123:o0' }],
      [{ text: 'Production', callback_data: 'tgq:q_123:o1' }],
    ],
  });
});

test('buildButtonMessage uses short buttonId for callback data when requestId is long or opaque', () => {
  const payload = buildButtonMessage(1000, {
    requestId: 'oc:ses_12345678901234567890:que_12345678901234567890',
    buttonId: 'b1',
    agent: 'opencode',
    kind: 'question',
    question: 'Pick one',
    options: [{ label: 'A' }],
  });
  expect(payload.reply_markup.inline_keyboard).toEqual([
    [{ text: 'A', callback_data: 'tgq:b1:o0' }],
  ]);
  expect(payload.reply_markup.inline_keyboard[0][0].callback_data.length).toBeLessThanOrEqual(64);
});

test('buildButtonMessage ignores invalid buttonId values', () => {
  const payload = buildButtonMessage(1000, {
    requestId: 'safe_request',
    buttonId: 'bad:id:that:cannot:roundtrip',
    agent: 'claude',
    kind: 'question',
    question: 'Pick one',
    options: [{ label: 'A' }],
  });
  expect(payload.reply_markup.inline_keyboard).toEqual([
    [{ text: 'A', callback_data: 'tgq:safe_request:o0' }],
  ]);
});

test('permission requests render approve/reject buttons', () => {
  const payload = buildButtonMessage(1000, {
    requestId: 'p_9',
    agent: 'codex',
    kind: 'permission',
    question: 'Run: rm -rf dist?',
  });
  expect(payload.text).toContain('Permission request from codex');
  expect(payload.reply_markup.inline_keyboard).toEqual([
    [
      { text: 'Approve', callback_data: 'tgq:p_9:allow' },
      { text: 'Reject', callback_data: 'tgq:p_9:deny' },
    ],
  ]);
});

test('parseButtonCallback accepts only tg-cli callback data', () => {
  expect(parseButtonCallback('tgq:q_123:o1')).toEqual({
    requestId: 'q_123',
    value: 'o1',
  });
  expect(parseButtonCallback('other:q_123:o1')).toBe(null);
  expect(parseButtonCallback('tgq:q_123')).toBe(null);
  expect(parseButtonCallback('tgq::o1')).toBe(null);
});

test('resolveButtonCallback maps option callbacks to labels', () => {
  expect(resolveButtonCallback(QUESTION, { requestId: 'q_123', value: 'o1' })).toEqual({
    status: 'answered',
    requestId: 'q_123',
    label: 'Production',
    value: 'Production',
  });
});

test('resolveButtonCallback resolves the default OK button when no options are supplied', () => {
  expect(
    resolveButtonCallback(
      { requestId: 'q_no_options', agent: 'claude', kind: 'question', question: 'Continue?' },
      { requestId: 'q_no_options', value: 'o0' },
    ),
  ).toEqual({
    status: 'answered',
    requestId: 'q_no_options',
    label: 'OK',
    value: 'OK',
  });
});

test('resolveButtonCallback accepts the short buttonId while preserving the full requestId', () => {
  expect(
    resolveButtonCallback(
      {
        requestId: 'oc:ses_12345678901234567890:que_12345678901234567890',
        buttonId: 'b1',
        agent: 'opencode',
        kind: 'question',
        question: 'Pick one',
        options: [{ label: 'A' }],
      },
      { requestId: 'b1', value: 'o0' },
    ),
  ).toMatchObject({
    status: 'answered',
    requestId: 'oc:ses_12345678901234567890:que_12345678901234567890',
    label: 'A',
  });
});

test('resolveButtonCallback maps permission callbacks to allow/deny decisions', () => {
  const req: ButtonRequest = {
    requestId: 'p_9',
    agent: 'codex',
    kind: 'permission',
    question: 'Run command?',
  };
  expect(resolveButtonCallback(req, { requestId: 'p_9', value: 'allow' })).toMatchObject({
    status: 'answered',
    decision: 'allow',
  });
  expect(resolveButtonCallback(req, { requestId: 'p_9', value: 'deny' })).toMatchObject({
    status: 'answered',
    decision: 'deny',
  });
});

test('formatAgentHookOutput emits Claude AskUserQuestion updatedInput answer shape', () => {
  const output = formatAgentHookOutput(QUESTION, {
    status: 'answered',
    requestId: 'q_123',
    label: 'Staging',
    value: 'Staging',
  });
  expect(output).toEqual({
    hookSpecificOutput: {
      permissionDecision: 'allow',
      updatedInput: {
        questions: [
          {
            header: 'Pick deploy target',
            question: 'Where should I deploy?',
            options: [
              { label: 'Staging', description: 'Safe validation environment' },
              { label: 'Production', description: 'Customer-facing environment' },
            ],
          },
        ],
        answers: {
          'Where should I deploy?': 'Staging',
        },
      },
    },
  });
});

test('formatAgentHookOutput emits Codex PermissionRequest shape', () => {
  const output = formatAgentHookOutput(
    { requestId: 'p_9', agent: 'codex', kind: 'permission', question: 'Run command?' },
    { status: 'answered', requestId: 'p_9', label: 'Reject', value: 'deny', decision: 'deny' },
  );
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: 'Rejected from Telegram',
      },
    },
  });
});

test('formatAgentHookOutput returns null for unsupported pi so local UI takes over', () => {
  const output = formatAgentHookOutput(
    { requestId: 'pi_1', agent: 'pi', kind: 'question', question: 'Continue?' },
    { status: 'unsupported', requestId: 'pi_1', reason: 'native question forwarding is not available for pi' },
  );
  expect(output).toBe(null);
});

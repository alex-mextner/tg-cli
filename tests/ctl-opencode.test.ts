import { expect, test } from 'bun:test';
import { opencodeEventToButtonRequest, opencodeReplyPlan } from '../features/tg-ctl/opencode';

test('opencodeEventToButtonRequest maps question.asked into a button request', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Pick a branch',
          header: 'Branch',
          custom: false,
          options: [
            { label: 'main', description: 'stable' },
            { label: 'feature', description: 'current branch' },
          ],
        },
      ],
    },
  });
  expect(req).toEqual({
    requestId: 'oc_ses_1_que_1',
    agent: 'opencode',
    kind: 'question',
    title: 'Branch',
    question: 'Pick a branch',
    options: [
      { label: 'main', description: 'stable' },
      { label: 'feature', description: 'current branch' },
    ],
    opencode: { sessionId: 'ses_1', requestId: 'que_1', replyKind: 'question' },
  });
});

test('opencodeEventToButtonRequest maps question.v2.asked to the v2 session reply kind', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.v2.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Pick a branch',
          header: 'Branch',
          custom: false,
          options: [{ label: 'main', description: 'stable' }],
        },
      ],
    },
  });
  expect(req).toMatchObject({
    requestId: 'oc_ses_1_que_1',
    agent: 'opencode',
    kind: 'question',
    opencode: { sessionId: 'ses_1', requestId: 'que_1', replyKind: 'question-v2' },
  });
});

test('opencodeEventToButtonRequest returns null for multi-question prompts instead of dropping answers', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        { question: 'Pick a branch', header: 'Branch', options: [{ label: 'main' }] },
        { question: 'Pick a region', header: 'Region', options: [{ label: 'eu' }] },
      ],
    },
  });
  expect(req).toBe(null);
});

test('opencodeEventToButtonRequest returns null for multi-select prompts instead of dropping answers', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Pick branches',
          header: 'Branches',
          multiple: true,
          options: [{ label: 'main' }, { label: 'feature' }],
        },
      ],
    },
  });
  expect(req).toBe(null);
});

test('opencodeEventToButtonRequest returns null for custom questions without concrete options', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Enter a branch name',
          header: 'Branch',
          custom: true,
        },
      ],
    },
  });
  expect(req).toBe(null);
});

test('opencodeEventToButtonRequest returns null when custom is omitted because opencode defaults it on', () => {
  const req = opencodeEventToButtonRequest({
    type: 'question.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'que_1',
      questions: [
        {
          question: 'Pick or type a branch',
          header: 'Branch',
          options: [{ label: 'main' }],
        },
      ],
    },
  });
  expect(req).toBe(null);
});

test('opencodeEventToButtonRequest maps permission.asked into approve/reject request', () => {
  const req = opencodeEventToButtonRequest({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'per_1',
      permission: 'bash',
      metadata: { command: 'bun test' },
      patterns: [],
      always: [],
    },
  });
  expect(req).toMatchObject({
    requestId: 'oc_ses_1_per_1',
    agent: 'opencode',
    kind: 'permission',
    title: 'bash',
    question: 'bash\nbun test',
    opencode: { sessionId: 'ses_1', requestId: 'per_1', replyKind: 'permission' },
  });
});

test('opencodeEventToButtonRequest includes permission patterns and resources in the prompt', () => {
  const req = opencodeEventToButtonRequest({
    type: 'permission.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'per_1',
      permission: 'edit',
      metadata: { input: { file: 'src/app.ts' } },
      patterns: ['src/*.ts'],
      resources: ['src/app.ts'],
      always: ['src/*.ts'],
      tool: { messageID: 'msg_1', callID: 'call_1' },
    },
  });
  expect(req?.question).toContain('edit');
  expect(req?.question).toContain('input: {"file":"src/app.ts"}');
  expect(req?.question).toContain('patterns: src/*.ts');
  expect(req?.question).toContain('resources: src/app.ts');
  expect(req?.question).toContain('always: src/*.ts');
  expect(req?.question).toContain('tool: {"messageID":"msg_1","callID":"call_1"}');
});

test('opencodeEventToButtonRequest maps permission.v2.asked to the v2 session reply kind', () => {
  const req = opencodeEventToButtonRequest({
    type: 'permission.v2.asked',
    properties: {
      sessionID: 'ses_1',
      id: 'per_1',
      permission: 'bash',
      metadata: { command: 'bun test' },
    },
  });
  expect(req).toMatchObject({
    requestId: 'oc_ses_1_per_1',
    agent: 'opencode',
    kind: 'permission',
    opencode: { sessionId: 'ses_1', requestId: 'per_1', replyKind: 'permission-v2' },
  });
});

test('opencodeReplyPlan builds question and permission reply endpoints', () => {
  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_req_1',
      agent: 'opencode',
      kind: 'question',
      question: 'Pick',
      opencode: { sessionId: 'ses_1', requestId: 'req_1', replyKind: 'question' },
    }, 'main'),
  ).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:4096/question/req_1/reply',
    body: { answers: [['main']] },
  });

  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_perm_1',
      agent: 'opencode',
      kind: 'permission',
      question: 'Run?',
      opencode: { sessionId: 'ses_1', requestId: 'perm_1', replyKind: 'permission' },
    }, 'allow'),
  ).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:4096/permission/perm_1/reply',
    body: { reply: 'once' },
  });
});

test('opencodeReplyPlan routes v2 question replies through the session endpoint', () => {
  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_req_1',
      agent: 'opencode',
      kind: 'question',
      question: 'Pick',
      opencode: { sessionId: 'ses_1', requestId: 'req_1', replyKind: 'question-v2' },
    }, 'main'),
  ).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:4096/api/session/ses_1/question/request/req_1/reply',
    body: { answers: [['main']] },
  });
});

test('opencodeReplyPlan routes v2 permission replies through the session endpoint', () => {
  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_perm_1',
      agent: 'opencode',
      kind: 'permission',
      question: 'Run?',
      opencode: { sessionId: 'ses_1', requestId: 'perm_1', replyKind: 'permission-v2' },
    }, 'allow'),
  ).toEqual({
    method: 'POST',
    url: 'http://127.0.0.1:4096/api/session/ses_1/permission/request/perm_1/reply',
    body: { reply: 'once' },
  });
});

test('opencodeReplyPlan maps permission deny to reject', () => {
  expect(
    opencodeReplyPlan('http://127.0.0.1:4096', {
      requestId: 'oc_ses_1_perm_1',
      agent: 'opencode',
      kind: 'permission',
      question: 'Run?',
      opencode: { sessionId: 'ses_1', requestId: 'perm_1', replyKind: 'permission' },
    }, 'deny'),
  ).toMatchObject({
    body: { reply: 'reject', message: 'Rejected from Telegram' },
  });
});

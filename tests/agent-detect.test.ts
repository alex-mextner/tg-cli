import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { detectAgentLabel, type AgentDetectDeps } from '../features/agent-detect/detect';

const fsDeps: AgentDetectDeps = {
  exists: existsSync,
  readdir: (path) => readdirSync(path, { withFileTypes: true }),
  readFile: (path) => readFileSync(path, 'utf8'),
  stat: (path) => {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  },
  homedir,
};

function writeClaudeSubagentMeta(
  home: string,
  projectDir: string,
  sessionId: string,
  agentId: string,
  meta: Record<string, unknown>,
): string {
  return writeClaudeSubagentMetaInConfig(join(home, '.claude'), projectDir, sessionId, agentId, meta);
}

function writeClaudeSubagentMetaInConfig(
  configDir: string,
  projectDir: string,
  sessionId: string,
  agentId: string,
  meta: Record<string, unknown>,
): string {
  const projectKey = projectDir.replace(/[^A-Za-z0-9]/g, '-');
  const dir = join(configDir, 'projects', projectKey, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `agent-${agentId}.meta.json`);
  writeFileSync(path, JSON.stringify(meta));
  return path;
}

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'tg-agent-detect-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// --- Explicit override wins over every auto-detection path ---
test('TG_AGENT explicit override wins, even alongside Claude Code child-session signals', () => {
  expect(detectAgentLabel({ TG_AGENT: 'hyperide-fixer' })).toBe('hyperide-fixer');
  expect(
    detectAgentLabel({
      TG_AGENT: 'hyperide-fixer',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
    }),
  ).toBe('hyperide-fixer');
});

// --- TG_AGENT is trimmed, and whitespace-only falls through to auto-detect
// (review finding, tg#6254): must behave the SAME as --agent's own
// whitespace-only rejection, not render an empty `[   ]` bracket. ---
test('TG_AGENT padded with whitespace is trimmed', () => {
  expect(detectAgentLabel({ TG_AGENT: '  hyperide-fixer  ' })).toBe('hyperide-fixer');
});

test('a whitespace-only TG_AGENT falls through to auto-detection, not an empty bracket', () => {
  expect(detectAgentLabel({ TG_AGENT: '   ', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' })).toBe(
    'subagent',
  );
  expect(detectAgentLabel({ TG_AGENT: '\t' })).toBe('');
});

// --- Claude Code: the one reliable automatic signal ---
test('Claude Code subagent (CLAUDE_CODE_CHILD_SESSION set) auto-detects as "subagent"', () => {
  expect(detectAgentLabel({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' })).toBe('subagent');
});

test('Claude Code subagent uses sidechain metadata description when child-session carries the agent id', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    writeClaudeSubagentMeta(home, projectDir, 'session-123', 'a93f269abbe5467f7', {
      description: 'Retro velocity analysis',
      toolUseId: 'toolu_123',
    });

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: 'agent-a93f269abbe5467f7',
      }, fsDeps),
    ).toBe('Retro velocity analysis');
  });
});

test('Claude Code subagent uses sidechain metadata matched by toolUseId', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    writeClaudeSubagentMeta(home, projectDir, 'session-123', '1111111111111111', {
      description: 'Wrong worker',
      toolUseId: 'toolu_wrong',
    });
    writeClaudeSubagentMeta(home, projectDir, 'session-123', '2222222222222222', {
      description: 'Fable review seat',
      toolUseId: 'toolu_right',
    });

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-123',
        CLAUDE_CODE_TOOL_USE_ID: 'toolu_right',
      }, fsDeps),
    ).toBe('Fable review seat');
  });
});

test('Claude Code subagent uses a single unambiguous fresh metadata record as a fallback', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    writeClaudeSubagentMeta(home, projectDir, 'session-123', 'a93f269abbe5467f7', {
      description: 'Single fresh worker',
    });

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-123',
      }, fsDeps),
    ).toBe('Single fresh worker');
  });
});

test('Claude Code subagent keeps the generic label when fresh metadata is ambiguous', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    writeClaudeSubagentMeta(home, projectDir, 'session-123', '1111111111111111', {
      description: 'Worker one',
    });
    writeClaudeSubagentMeta(home, projectDir, 'session-123', '2222222222222222', {
      description: 'Worker two',
    });

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-123',
      }, fsDeps),
    ).toBe('subagent');
  });
});

// Production shape (tg#7012/#7108): a Task-tool subagent's own cwd (PWD) is a
// WORKTREE, never the orchestrator's project dir. Claude writes the metadata
// under the ORCHESTRATOR's project key + the (parent) session id, so the project
// key cannot be derived from PWD. The only reliable locator is
// CLAUDE_CODE_SESSION_ID. Before the fix, detection derived the project key from
// PWD, missed the real subagents dir, and always fell back to 'subagent'.
test('Claude Code subagent finds metadata by session id when PWD is a worktree, not the project dir', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    // The subagent runs in a worktree whose path dashes to a DIFFERENT project
    // key that has no subagents dir of its own.
    const worktreeDir = '/Users/alex/work/hyperide/.worktrees/agent-aae53807f09d9cffa';
    writeClaudeSubagentMeta(home, projectDir, 'session-parent', 'a93f269abbe5467f7', {
      description: 'Fix ctl routing',
    });

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: worktreeDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-parent',
      }, fsDeps),
    ).toBe('Fix ctl routing');
  });
});

test('Claude Code freshness fallback ignores fresh metadata from another session', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    writeClaudeSubagentMeta(home, projectDir, 'other-session', '1111111111111111', {
      description: 'Other session worker',
    });

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'current-session',
      }, fsDeps),
    ).toBe('subagent');
  });
});

test('Claude Code freshness fallback ignores stale metadata', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    const path = writeClaudeSubagentMeta(home, projectDir, 'session-123', 'a93f269abbe5467f7', {
      description: 'Stale worker',
    });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(path, old, old);

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-123',
      }, fsDeps),
    ).toBe('subagent');
  });
});

test('Claude Code invalid or incomplete metadata falls back to the generic label', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    const projectKey = projectDir.replace(/\//g, '-');
    const dir = join(home, '.claude', 'projects', projectKey, 'session-123', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-badjson.meta.json'), '{');
    writeFileSync(join(dir, 'agent-empty.meta.json'), JSON.stringify({ description: 123 }));

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-123',
      }, fsDeps),
    ).toBe('subagent');
  });
});

test('Claude Code metadata can fall back to agentType when description is missing', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    writeClaudeSubagentMeta(home, projectDir, 'session-123', 'a93f269abbe5467f7', {
      agentType: 'general-purpose',
    });

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-123',
      }, fsDeps),
    ).toBe('general-purpose');
  });
});

test('Claude Code metadata labels are collapsed and truncated', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    writeClaudeSubagentMeta(home, projectDir, 'session-123', 'a93f269abbe5467f7', {
      description: `${'A'.repeat(50)} \n ${'B'.repeat(50)}`,
    });

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-123',
      }, fsDeps),
    ).toBe(`${'A'.repeat(50)} ${'B'.repeat(26)}...`);
  });
});

test('CLAUDE_CONFIG_DIR overrides the default ~/.claude metadata directory', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/work/hyperide';
    const configDir = join(home, 'custom-claude');
    writeClaudeSubagentMetaInConfig(configDir, projectDir, 'session-123', 'a93f269abbe5467f7', {
      description: 'Custom config worker',
    });

    expect(
      detectAgentLabel({
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-123',
      }, fsDeps),
    ).toBe('Custom config worker');
  });
});

test('Claude project key derivation matches dot and worktree path encoding', () => {
  withTempHome((home) => {
    const projectDir = '/Users/alex/.files/repos/tg-cli/.worktrees/feat-v1.2';
    const dir = join(
      home,
      '.claude',
      'projects',
      '-Users-alex--files-repos-tg-cli--worktrees-feat-v1-2',
      'session-123',
      'subagents',
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent-a93f269abbe5467f7.meta.json'),
      JSON.stringify({ description: 'Dotted worktree worker' }),
    );

    expect(
      detectAgentLabel({
        HOME: home,
        PWD: projectDir,
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'session-123',
      }, fsDeps),
    ).toBe('Dotted worktree worker');
  });
});

test('false-like Claude Code child-session values do not mark the top-level process as a subagent', () => {
  expect(detectAgentLabel({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '0' })).toBe('');
  expect(detectAgentLabel({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: 'false' })).toBe('');
  expect(detectAgentLabel({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: 'FALSE' })).toBe('');
  expect(detectAgentLabel({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: 'No' })).toBe('');
  expect(detectAgentLabel({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: 'NULL' })).toBe('');
});

test('Claude Code detected via CLAUDE_CODE_ENTRYPOINT alone (no CLAUDECODE) still counts', () => {
  expect(detectAgentLabel({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_CHILD_SESSION: '1' })).toBe(
    'subagent',
  );
});

test('Claude Code top-level session (no CLAUDE_CODE_CHILD_SESSION) has no auto label', () => {
  expect(detectAgentLabel({ CLAUDECODE: '1' })).toBe('');
  expect(detectAgentLabel({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('');
});

// --- Codex / opencode: no auto-detection today (see doc comment for why) ---
test('Codex env alone has no auto label — no child/parent signal exists to read', () => {
  expect(detectAgentLabel({ CODEX: '1' })).toBe('');
});

test('opencode env alone has no auto label — no child/parent signal exists to read', () => {
  expect(detectAgentLabel({ OPENCODE: '1' })).toBe('');
});

// --- Nothing at all ---
test('empty env has no auto label', () => {
  expect(detectAgentLabel({})).toBe('');
});

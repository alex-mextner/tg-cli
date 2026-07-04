// --- Subagent identification (the `[agent]` prefix bracket) ---
//
// An orchestrator that fans work out to several subagents (Claude Code's Task
// tool, and equivalents in other harnesses) loses the sender's identity once a
// subagent calls `tg` directly: the recipient sees a message with no way to
// tell "the orchestrator" from "subagent #3" apart, other than reading prose.
// This module answers ONE question — what auto-detectable label (if any)
// identifies the CURRENT process as a subagent — pure and env-injected like
// `detectAiModel` in the `tg` entrypoint, so it is unit-testable without a
// real subagent harness running.
//
// Investigated 2026-07-04 (tg#6254) against every harness installed on the
// dev machine:
//   - Claude Code (2.1.199): the Task-tool child process inherits
//     `CLAUDE_CODE_CHILD_SESSION=1` from the harness — present ONLY in a
//     subagent's own env, absent in the top-level/orchestrator process. This
//     is the one reliable, fully-automatic "is this a subagent" signal found.
//     It does NOT identify WHICH subagent: `CLAUDE_CODE_SESSION_ID` is the
//     shared top-level session id (identical across the orchestrator and every
//     sibling subagent), and no per-agent id, type, or task description
//     reaches the child process env. So the auto label stays the generic
//     `subagent` — a caller that wants a specific name (e.g. the dispatched
//     task's description) MUST pass `--agent <name>` itself.
//   - Codex CLI (0.142.4): `codex exec` sub-invocations expose no child/parent
//     distinguishing env var (`codex --help` / `codex exec --help` have no
//     such flag either) — a nested Codex run looks identical to a top-level
//     one from inside. No auto-detection possible.
//   - opencode (1.17.10): has a first-class `agent` concept (`opencode agent`,
//     `--agent <name>`) and sessions, but no env var was found that a spawned
//     subprocess could read to learn which agent/session launched it. No
//     auto-detection possible.
//   - Pi: not installed on the dev machine; unverified.
// For everything but Claude Code's binary child/top-level flag, `--agent` (or
// the `TG_AGENT` env override below) is the ONLY way to label a message.
export interface AgentDetectEnv {
  // The real call site passes the full merged `{ ...configEnv, ...process.env
  // }` bag (dozens of unrelated keys) — the index signature keeps that a
  // direct, uncast fit; the named optional props below are the ones this
  // function actually reads.
  [key: string]: string | undefined;
  // Explicit override — wins over every auto-detection path, mirroring the
  // `TG_AI_MODEL` precedent in `detectAiModel`. Set this once in a subagent's
  // own shell env when a per-call `--agent` flag would be repetitive.
  TG_AGENT?: string;
  // Claude Code sets one of these in every session (top-level or subagent).
  CLAUDECODE?: string;
  CLAUDE_CODE_ENTRYPOINT?: string;
  // Present ONLY in a Task-tool-spawned subagent's own process env.
  CLAUDE_CODE_CHILD_SESSION?: string;
}

// Returns the auto-detectable label for the CURRENT process, or '' when none
// applies (the caller falls back to no bracket / an explicit `--agent`).
export function detectAgentLabel(env: AgentDetectEnv): string {
  // Trimmed the same way --agent's parser trims/rejects its value (review
  // finding, tg#6254): a whitespace-only TG_AGENT ("   ") must fall through to
  // auto-detection below, not render an empty `[   ]` bracket that silently
  // short-circuits the Claude Code subagent signal. A padded value (" foo ")
  // is trimmed so both paths render an identical `[foo]`.
  const explicit = env.TG_AGENT?.trim();
  if (explicit) return explicit;

  const isClaudeCode = !!(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT);
  if (isClaudeCode && env.CLAUDE_CODE_CHILD_SESSION) return 'subagent';

  return '';
}

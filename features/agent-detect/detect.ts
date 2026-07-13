import { basename, join } from 'path';

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
// Investigated 2026-07-04 (tg#6254) and updated 2026-07-08 against every
// harness installed on the dev machine:
//   - Claude Code: the Task-tool child process inherits
//     `CLAUDE_CODE_CHILD_SESSION=1` from the harness — present ONLY in a
//     subagent's own env, absent in the top-level/orchestrator process. This
//     is the reliable, fully-automatic "is this a subagent" signal. Newer
//     Claude sidechain state also writes per-agent metadata under
//     `~/.claude/projects/<project>/<session>/subagents/*.meta.json`; when the
//     current child can be matched by agent id, toolUseId, or a single
//     unambiguous fresh metadata record, `tg` uses that description as the
//     auto label. If matching is ambiguous or the metadata is unreadable, the
//     label stays the generic `subagent`.
//   - Codex CLI (0.142.4): `codex exec` sub-invocations expose no child/parent
//     distinguishing env var (`codex --help` / `codex exec --help` have no
//     such flag either) — a nested Codex run looks identical to a top-level
//     one from inside. No auto-detection possible.
//   - opencode (1.17.10): has a first-class `agent` concept (`opencode agent`,
//     `--agent <name>`) and sessions, but no env var was found that a spawned
//     subprocess could read to learn which agent/session launched it. No
//     auto-detection possible.
//   - Pi: not installed on the dev machine; unverified.
// For everything but Claude Code's child/top-level flag and sidechain metadata,
// `--agent` (or the `TG_AGENT` env override below) is the ONLY way to label a
// message.
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
  // Claude Code session metadata, when present. These names are intentionally
  // tolerant because Claude has changed the exact env surface across versions.
  CLAUDE_CODE_SESSION_ID?: string;
  CLAUDE_SESSION_ID?: string;
  CLAUDE_CODE_AGENT_ID?: string;
  CLAUDE_AGENT_ID?: string;
  CLAUDE_CODE_TOOL_USE_ID?: string;
  CLAUDE_CODE_TASK_TOOL_USE_ID?: string;
  CLAUDE_TOOL_USE_ID?: string;
  CLAUDE_CONFIG_DIR?: string;
  CLAUDE_PROJECT_DIR?: string;
  CLAUDE_CODE_PROJECT_DIR?: string;
  CLAUDE_CODE_CWD?: string;
  HOME?: string;
  PWD?: string;
}

interface ClaudeSubagentMeta {
  description?: unknown;
  agentType?: unknown;
  toolUseId?: unknown;
}

interface ClaudeSubagentRecord {
  path: string;
  agentId: string;
  label: string;
  toolUseId: string;
  mtimeMs: number;
  freshFallbackAllowed: boolean;
}

interface ClaudeSubagentDir {
  path: string;
  freshFallbackAllowed: boolean;
}

export interface AgentDetectDirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface AgentDetectStats {
  mtimeMs: number;
  isDirectory(): boolean;
}

export interface AgentDetectDeps {
  exists(path: string): boolean;
  readdir(path: string): AgentDetectDirEntry[];
  readFile(path: string): string;
  stat(path: string): AgentDetectStats | null;
  homedir(): string;
}

const GENERIC_CLAUDE_SUBAGENT_LABEL = 'subagent';
const CLAUDE_META_FRESH_MS = 2 * 60 * 60 * 1000;
const MAX_PROJECT_SESSIONS_TO_SCAN = 24;
const MAX_LABEL_LENGTH = 80;
const EMPTY_DEPS: AgentDetectDeps = {
  exists: () => false,
  readdir: () => [],
  readFile: () => {
    throw new Error('agent-detect readFile dependency is not configured');
  },
  stat: () => null,
  homedir: () => '',
};

// Returns the auto-detectable label for the CURRENT process, or '' when none
// applies (the caller falls back to no bracket / an explicit `--agent`).
export function detectAgentLabel(env: AgentDetectEnv, deps: AgentDetectDeps = EMPTY_DEPS): string {
  // Trimmed the same way --agent's parser trims/rejects its value (review
  // finding, tg#6254): a whitespace-only TG_AGENT ("   ") must fall through to
  // auto-detection below, not render an empty `[   ]` bracket that silently
  // short-circuits the Claude Code subagent signal. A padded value (" foo ")
  // is trimmed so both paths render an identical `[foo]`.
  const explicit = env.TG_AGENT?.trim();
  if (explicit) return explicit;

  const isClaudeCode = !!(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT);
  const childSession = env.CLAUDE_CODE_CHILD_SESSION?.trim() ?? '';
  if (isClaudeCode && isTruthySignal(childSession)) {
    return detectClaudeSubagentLabel(env, deps, childSession) ?? GENERIC_CLAUDE_SUBAGENT_LABEL;
  }

  return '';
}

function detectClaudeSubagentLabel(
  env: AgentDetectEnv,
  deps: AgentDetectDeps,
  childSession: string,
): string | null {
  const records = readClaudeSubagentRecords(env, deps);
  if (records.length === 0) return null;

  const explicitAgentId = firstNonEmpty(
    env.CLAUDE_CODE_AGENT_ID,
    env.CLAUDE_AGENT_ID,
    agentIdFromMaybeChildSession(childSession),
  );
  if (explicitAgentId) {
    const wanted = normalizeAgentId(explicitAgentId);
    const record = records.find((r) => r.agentId === wanted);
    if (record) return record.label;
  }

  const toolUseId = firstNonEmpty(
    env.CLAUDE_CODE_TOOL_USE_ID,
    env.CLAUDE_CODE_TASK_TOOL_USE_ID,
    env.CLAUDE_TOOL_USE_ID,
  );
  if (toolUseId) {
    const record = records.find((r) => r.toolUseId === toolUseId);
    if (record) return record.label;
  }

  const fresh = records.filter((r) => r.freshFallbackAllowed && Date.now() - r.mtimeMs <= CLAUDE_META_FRESH_MS);
  return fresh.length === 1 ? fresh[0].label : null;
}

function readClaudeSubagentRecords(env: AgentDetectEnv, deps: AgentDetectDeps): ClaudeSubagentRecord[] {
  const records: ClaudeSubagentRecord[] = [];
  const seen = new Set<string>();
  for (const dir of claudeSubagentDirs(env, deps)) {
    for (const entry of safeReaddir(deps, dir.path)) {
      if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue;
      const path = join(dir.path, entry.name);
      if (seen.has(path)) continue;
      seen.add(path);
      const record = readClaudeSubagentRecord(deps, path, dir.freshFallbackAllowed);
      if (record) records.push(record);
    }
  }
  return records;
}

function readClaudeSubagentRecord(
  deps: AgentDetectDeps,
  path: string,
  freshFallbackAllowed: boolean,
): ClaudeSubagentRecord | null {
  let meta: ClaudeSubagentMeta;
  try {
    meta = JSON.parse(deps.readFile(path)) as ClaudeSubagentMeta;
  } catch {
    return null;
  }

  const label = labelFromClaudeMeta(meta);
  if (!label) return null;

  const agentId = normalizeAgentId(basename(path).replace(/\.meta\.json$/, ''));
  if (!agentId) return null;

  const jsonlPath = path.replace(/\.meta\.json$/, '.jsonl');
  const metaStat = safeStat(deps, path);
  const jsonlStat = safeStat(deps, jsonlPath);
  const mtimeMs = Math.max(metaStat?.mtimeMs ?? 0, jsonlStat?.mtimeMs ?? 0);

  return {
    path,
    agentId,
    label,
    toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId.trim() : '',
    mtimeMs,
    freshFallbackAllowed,
  };
}

function labelFromClaudeMeta(meta: ClaudeSubagentMeta): string {
  const description = typeof meta.description === 'string' ? meta.description : '';
  const agentType = typeof meta.agentType === 'string' ? meta.agentType : '';
  return cleanAutoLabel(description) || cleanAutoLabel(agentType);
}

function cleanAutoLabel(value: string): string {
  const label = value.replace(/\s+/g, ' ').trim();
  if (!label) return '';
  if (label.length <= MAX_LABEL_LENGTH) return label;
  return `${label.slice(0, MAX_LABEL_LENGTH - 3).trimEnd()}...`;
}

function claudeSubagentDirs(env: AgentDetectEnv, deps: AgentDetectDeps): ClaudeSubagentDir[] {
  const root = join(claudeConfigDir(env, deps), 'projects');
  if (!deps.exists(root)) return [];

  const sessionIds = unique(
    [env.CLAUDE_CODE_SESSION_ID, env.CLAUDE_SESSION_ID].map((s) => safePathSegment(s)),
  );
  const projectKeys = unique(
    [
      env.CLAUDE_PROJECT_DIR,
      env.CLAUDE_CODE_PROJECT_DIR,
      env.CLAUDE_CODE_CWD,
      env.PWD,
    ].map((p) => claudeProjectKey(p)),
  );

  const dirs: ClaudeSubagentDir[] = [];
  for (const projectKey of projectKeys) {
    for (const sessionId of sessionIds) {
      dirs.push({ path: join(root, projectKey, sessionId, 'subagents'), freshFallbackAllowed: true });
    }
  }
  // Scan EVERY project dir for the current session id. A Task-tool subagent's own
  // cwd (PWD) is a WORKTREE, not the orchestrator's project dir, so the project
  // key above (derived from PWD) points at a dir that has no subagents — Claude
  // writes the metadata under the ORCHESTRATOR's project key + the parent session
  // id (CLAUDE_CODE_SESSION_ID). Locating by session id is the only reliable way
  // (tg#7012/#7108). This used to be gated on `projectKeys.length === 0`, which
  // made it dead code in practice — PWD is essentially always set, so the gate
  // never opened and detection always fell back to the generic 'subagent'.
  for (const sessionId of sessionIds) {
    for (const project of safeReaddir(deps, root)) {
      if (!project.isDirectory()) continue;
      dirs.push({ path: join(root, project.name, sessionId, 'subagents'), freshFallbackAllowed: true });
    }
  }
  for (const projectKey of projectKeys) {
    const projectRoot = join(root, projectKey);
    const sessions = safeReaddir(deps, projectRoot)
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(projectRoot, entry.name);
        return { name: entry.name, mtimeMs: safeStat(deps, path)?.mtimeMs ?? 0 };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_PROJECT_SESSIONS_TO_SCAN);
    for (const session of sessions) {
      dirs.push({ path: join(projectRoot, session.name, 'subagents'), freshFallbackAllowed: false });
    }
  }

  return uniqueDirs(dirs).filter((dir) => safeStat(deps, dir.path)?.isDirectory());
}

function claudeConfigDir(env: AgentDetectEnv, deps: AgentDetectDeps): string {
  const configured = expandHome(env.CLAUDE_CONFIG_DIR?.trim() ?? '', env, deps);
  if (configured) return configured;
  const home = expandHome(env.HOME?.trim() ?? '', env, deps) || deps.homedir();
  return join(home, '.claude');
}

function claudeProjectKey(path: string | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed || !trimmed.startsWith('/')) return '';
  return trimmed.replace(/[^A-Za-z0-9]/g, '-');
}

function expandHome(path: string, env: AgentDetectEnv, deps: AgentDetectDeps): string {
  if (!path) return '';
  if (path === '~') return env.HOME || deps.homedir();
  if (path.startsWith('~/')) return join(env.HOME || deps.homedir(), path.slice(2));
  return path;
}

function safePathSegment(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return /^[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : '';
}

function agentIdFromMaybeChildSession(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('agent-')) return trimmed;
  return '';
}

function normalizeAgentId(value: string): string {
  let normalized = value.trim();
  normalized = basename(normalized);
  normalized = normalized.replace(/\.meta\.json$/, '').replace(/\.jsonl$/, '');
  normalized = normalized.startsWith('agent-') ? normalized.slice('agent-'.length) : normalized;
  return /^[A-Za-z0-9_.-]+$/.test(normalized) ? normalized : '';
}

function isTruthySignal(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !!normalized && !['0', 'false', 'no', 'none', 'null'].includes(normalized);
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? '';
    if (trimmed) return trimmed;
  }
  return '';
}

function unique(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueDirs(values: ClaudeSubagentDir[]): ClaudeSubagentDir[] {
  const result: ClaudeSubagentDir[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const existing = result.find((dir) => dir.path === value.path);
    if (existing) {
      existing.freshFallbackAllowed = existing.freshFallbackAllowed || value.freshFallbackAllowed;
      continue;
    }
    if (seen.has(value.path)) continue;
    seen.add(value.path);
    result.push({ ...value });
  }
  return result;
}

function safeReaddir(deps: AgentDetectDeps, path: string): AgentDetectDirEntry[] {
  try {
    return deps.readdir(path);
  } catch {
    return [];
  }
}

function safeStat(deps: AgentDetectDeps, path: string): AgentDetectStats | null {
  try {
    return deps.stat(path);
  } catch {
    return null;
  }
}

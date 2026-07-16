// Model catalog for forum-topics and flat-chat `/new` (docs/specs/tg-forum-topics.md §6).
//
// PURE data: the single source of truth for BOTH the awaiting-model inline buttons
// AND the spawn argv, so the two can never drift. The entrypoint runs the argv via
// `tmux new-window … -- <argv>`; tests assert the catalog shape and the argv builder.
//
// Spawn recipes are tied to local CLI help/contracts:
//   codex [--model <id>] [PROMPT]
//   opencode [project] --model <provider/model> --prompt=<text>

import type { SpawnHarness } from './types';
export type { SpawnHarness };

export interface ModelEntry {
  id: string; // stable catalog id, persisted in TopicBinding.model + callback_data
  label: string; // button text
  kind: SpawnHarness; // which agent binary this launches
  // The command to launch the agent in `path`. Kept as a builder (not a static string)
  // so a path with spaces is passed as a single argv element, never shell-split.
  argv: (path: string) => string[];
  // How this CLI accepts an initial prompt. Most harnesses accept a positional prompt after
  // `--`; opencode's TUI uses `--prompt=...`, so the catalog owns the difference.
  promptArgv?: (task: string) => string[];
}

export const SPAWN_HARNESSES: readonly SpawnHarness[] = ['claude', 'codex', 'opencode'] as const;

// tg#8708 (option a): every codex session spawned from `/new` runs rig-managed codex hooks
// (~/.codex/config.toml, provisioned by `rig apply` — see features/tg-ctl/rig-delegate.ts) that
// codex otherwise refuses to run because they are "untrusted" for THIS invocation (codex's
// per-invocation hook-trust gate, distinct from the harness-wide sandbox approval prompts). rig
// already vouches for the hooks it writes, so bypass codex's own trust gate at spawn time rather
// than have every autonomous codex session silently skip its hooks. This module is PURE, so the
// flag is NOT baked into the argv here — it is inserted at spawn time (as an OPTION, ahead of any
// `--` prompt separator), and ONLY when codex hooks are actually rig-managed (see
// applyCodexHookTrustBypass in features/tg-ctl/rig-delegate.ts):
// bypassing codex's trust gate is only justified for hooks rig vouches for, never for a user's
// own untrusted hooks on a machine without rig.

export function harnessLabel(harness: SpawnHarness): string {
  if (harness === 'claude') return 'Claude';
  if (harness === 'codex') return 'Codex';
  // opencode styles its CLI/brand name lowercase.
  return 'opencode';
}

// Order = button order; the first entry is the highlighted default.
export const MODEL_CATALOG: readonly ModelEntry[] = [
  {
    id: 'claude-default',
    label: 'Claude (default)',
    kind: 'claude',
    argv: () => ['claude'],
  },
  {
    id: 'claude-opus',
    label: 'Claude Opus',
    kind: 'claude',
    argv: () => ['claude', '--model', 'opus'],
  },
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet',
    kind: 'claude',
    argv: () => ['claude', '--model', 'sonnet'],
  },
  {
    id: 'claude-haiku',
    label: 'Claude Haiku',
    kind: 'claude',
    argv: () => ['claude', '--model', 'haiku'],
  },
  {
    id: 'codex-default',
    label: 'Codex (default)',
    kind: 'codex',
    argv: () => ['codex'],
  },
  {
    id: 'codex-gpt-5.5',
    label: 'Codex GPT-5.5',
    kind: 'codex',
    argv: () => ['codex', '--model', 'gpt-5.5'],
  },
  {
    id: 'codex-gpt-5.4',
    label: 'Codex GPT-5.4',
    kind: 'codex',
    argv: () => ['codex', '--model', 'gpt-5.4'],
  },
  {
    id: 'codex-gpt-5.4-mini',
    label: 'Codex GPT-5.4 Mini',
    kind: 'codex',
    argv: () => ['codex', '--model', 'gpt-5.4-mini'],
  },
  {
    id: 'codex-spark',
    label: 'Codex Spark',
    kind: 'codex',
    argv: () => ['codex', '--model', 'gpt-5.3-codex-spark'],
  },
  {
    id: 'opencode-zai-glm-5.2',
    label: 'opencode GLM-5.2',
    kind: 'opencode',
    argv: () => ['opencode', '--model', 'zai/glm-5.2'],
    promptArgv: (task) => [`--prompt=${task}`],
  },
  {
    id: 'opencode-kimi',
    label: 'opencode Kimi K2.7',
    kind: 'opencode',
    argv: () => ['opencode', '--model', 'commandcode/moonshotai/Kimi-K2.7-Code'],
    promptArgv: (task) => [`--prompt=${task}`],
  },
  {
    id: 'opencode-deepseek',
    label: 'opencode DeepSeek V4',
    kind: 'opencode',
    argv: () => ['opencode', '--model', 'commandcode/deepseek/deepseek-v4-pro'],
    promptArgv: (task) => [`--prompt=${task}`],
  },
  {
    id: 'opencode-qwen',
    label: 'opencode Qwen3.7 Max',
    kind: 'opencode',
    argv: () => ['opencode', '--model', 'commandcode/Qwen/Qwen3.7-Max'],
    promptArgv: (task) => [`--prompt=${task}`],
  },
] as const;

export const DEFAULT_MODEL_ID = MODEL_CATALOG[0].id;

export function findModel(id: string): ModelEntry | null {
  return MODEL_CATALOG.find((m) => m.id === id) ?? null;
}

export function modelsForHarness(harness: SpawnHarness): ModelEntry[] {
  return MODEL_CATALOG.filter((m) => m.kind === harness);
}

// The argv to spawn `modelId`'s agent in `path`. Null for an unknown id (the caller
// re-asks rather than launching a bare/ambiguous agent). Path is NOT shell-quoted here —
// it is a discrete argv element the entrypoint hands to `tmux new-window -- …`.
export function spawnArgv(modelId: string, path: string): string[] | null {
  const entry = findModel(modelId);
  return entry ? entry.argv(path) : null;
}

export function spawnArgvWithTask(modelId: string, path: string, task: string): string[] | null {
  const entry = findModel(modelId);
  if (!entry) return null;
  const base = entry.argv(path);
  const trimmed = task.trim();
  if (!trimmed) return base;
  return [...base, ...(entry.promptArgv ? entry.promptArgv(trimmed) : ['--', trimmed])];
}

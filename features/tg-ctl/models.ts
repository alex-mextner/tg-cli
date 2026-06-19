// Model catalog for forum-topics `/new` (docs/specs/tg-forum-topics.md §6).
//
// PURE data: the single source of truth for BOTH the awaiting-model inline buttons
// AND the spawn argv, so the two can never drift. The entrypoint runs the argv via
// `tmux new-window … -- <argv>`; tests assert the catalog shape and the argv builder.
//
// v1 ships the Claude tiers + a no-`--model` default. codex/opencode entries land once
// their spawn recipe is verified live (each agent kind starts differently); the `kind`
// field is already here so the executor can branch without a catalog reshape.

import type { AgentKind } from './types';

export interface ModelEntry {
  id: string; // stable catalog id, persisted in TopicBinding.model + callback_data
  label: string; // button text
  kind: AgentKind; // which agent binary this launches
  // The command to launch the agent in `path`. Kept as a builder (not a static string)
  // so a path with spaces is passed as a single argv element, never shell-split.
  argv: (path: string) => string[];
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
] as const;

export const DEFAULT_MODEL_ID = MODEL_CATALOG[0].id;

export function findModel(id: string): ModelEntry | null {
  return MODEL_CATALOG.find((m) => m.id === id) ?? null;
}

// The argv to spawn `modelId`'s agent in `path`. Null for an unknown id (the caller
// re-asks rather than launching a bare/ambiguous agent). Path is NOT shell-quoted here —
// it is a discrete argv element the entrypoint hands to `tmux new-window -- …`.
export function spawnArgv(modelId: string, path: string): string[] | null {
  const entry = findModel(modelId);
  return entry ? entry.argv(path) : null;
}

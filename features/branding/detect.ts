// Agent / process detection used for outbound branding (tg decomposition Stage
// 0b, docs/specs/tg-decomposition.md). Extracted verbatim from `tg` — behaviour
// unchanged. Real spawns live here (the entrypoint imports these); the pure
// process-tree parsing is reused from features/tg-ctl/discover.
import { findAgentInAncestry, parseProcList } from "../tg-ctl/discover"

export function isProcessRunning(name: string): boolean {
  try {
    const result = Bun.spawnSync(["pgrep", "-x", name], {
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}

// Which agent launched this `tg` process? Climb the ppid chain and match the
// nearest ancestor command (codex/aider/pi/opencode/claude). This is the
// reliable signal for agents that — unlike Claude Code's CLAUDECODE — export no
// env marker: a `codex exec` is the direct parent of the shell command it runs.
// Crucially it runs BEFORE the pgrep fallbacks so a background `ollama` daemon
// (a sibling, never an ancestor) can no longer hijack the label.
export function detectAgentViaAncestry(): string | null {
  try {
    const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) return null
    const procs = parseProcList(new TextDecoder().decode(result.stdout))
    const found = findAgentInAncestry(procs, process.ppid)
    return found?.agent ?? null
  } catch {
    return null
  }
}

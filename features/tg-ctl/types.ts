// Shared contract for the tg-ctl feature modules (spec §16).
//
// Everything in features/tg-ctl/ is PURE — no I/O. The tg-ctl entrypoint owns
// real spawns, fetch, ffi flock and file I/O, and feeds these modules plain
// data. Tests construct the same data by hand.

// --- config (spec §9) ---

export interface ControlConfig {
  enabled: boolean;
  transport: 'auto' | 'tmux' | 'channel'; // 'channel' reserved for v1.2+
  session?: string; // fixed tmux session name (else auto-discover)
  injectWrap: string; // template: {name}, {msg}
  stalenessSec: number; // drop inbound older than this (default 300)
  idleExitMin: number; // daemon exits after this long with no agent pane (default 30)
  allowedSenders: number[]; // extra allowed sender user ids
}

// enabled defaults ON (user decision 2026-06-10, post-review): inbound is armed
// out of the box wherever the bot token exists; opt OUT per machine with
// `control.enabled: false`. The auto-start gate still requires tmux + a
// detected agent, and D3 (bot-per-machine) becomes a practical requirement.
export const DEFAULT_CONTROL: ControlConfig = {
  enabled: true,
  transport: 'auto',
  injectWrap: '[TG from {name}] {msg} — reply via tg',
  stalenessSec: 300,
  idleExitMin: 30,
  allowedSenders: [],
};

// --- Telegram update shapes (only the fields we read) ---

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  date: number; // unix seconds
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// --- update step function (spec §16 module 4) ---

// Actions are data; the entrypoint executes them in order.
export type Action =
  | { kind: 'inject-text'; text: string } // already wrapped (or verbatim /cmd passthrough)
  | { kind: 'inject-key'; key: 'Escape' } // /stop
  | { kind: 'kill-agent' } // /kill — SIGINT to the registered pane's agent pid
  | { kind: 'status' } // /status — entrypoint composes the reply
  | { kind: 'reply'; text: string } // sendMessage back to the chat
  | {
      kind: 'download-media';
      fileId: string;
      suggestedName: string; // daemon-chosen: <update_id>.<ext>
      mediaKind: 'photo' | 'document';
      fileSize?: number;
      caption?: string;
      from: string; // display name for the wrap
    };

export interface StepResult {
  actions: Action[];
  newOffset: number; // next getUpdates offset (last update_id + 1)
  skippedStale: number; // count for the one-shot "skipped N stale" notice
}

// --- tmux injection plans (spec §16 module 5) ---

export type InjectStep =
  | { kind: 'verify-pane'; paneId: string } // entrypoint re-checks agent still in pane
  | { kind: 'tmux'; argv: string[]; stdin?: string } // tmux command; stdin for load-buffer -
  | { kind: 'sleep'; ms: number };

// --- pane discovery (spec §16 module 6) ---

export interface PaneInfo {
  sessionName: string;
  windowIndex: number;
  paneId: string; // "%N"
  panePid: number;
  paneCommand: string; // pane_current_command — VERSION string for cc!
  panePath: string; // pane_current_path
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string; // full command line
}

export type AgentKind = 'claude' | 'opencode' | 'codex' | 'aider' | 'unknown';

// Snapshot written by `tg` / `tg-ctl start` at auto-start time (spec §5.2).
export interface Registration {
  paneId?: string;
  cwd?: string;
  sessionName?: string;
  registeredAt?: number; // unix seconds
}

export interface TargetPane {
  pane: PaneInfo;
  agent: AgentKind;
  agentPid?: number;
}

export type DiscoverResult =
  | { ok: true; target: TargetPane }
  | { ok: false; reason: 'no-agent' | 'ambiguous'; candidates: TargetPane[] };

// --- lock/status helpers (spec §16 module 3) ---

export interface CtlPaths {
  lock: string;
  pid: string;
  offset: string;
  registration: string;
  log: string;
}

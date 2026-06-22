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
  // Forum-topics mode (docs/specs/tg-forum-topics.md). Default OFF: when false the daemon
  // never enters topic mode and a forum-topic message falls through to the normal flat
  // handling (1:1 behaviour byte-identical). Opt in per machine with `control.topics: true`
  // once the chat is a forum supergroup with the bot as a topic-managing admin.
  topics: boolean;
}

// enabled defaults ON (user decision 2026-06-10, post-review): inbound is armed
// out of the box wherever the bot token exists; opt OUT per machine with
// `control.enabled: false`. The auto-start gate still requires tmux + a
// detected agent, and D3 (bot-per-machine) becomes a practical requirement.
export const DEFAULT_CONTROL: ControlConfig = {
  enabled: true,
  transport: 'auto',
  // `{id}` renders the inbound Telegram message_id as `#<id>` — the agent passes
  // it to `tg --reply-to <id>` to thread its answer under this exact message.
  // When no id is available (a /agent route, a media item) `{id}` collapses with
  // its leading space (see wrapInbound), so the wrap stays `[TG from {name}] …`.
  injectWrap: '[TG from {name} {id}] {msg}',
  stalenessSec: 300,
  idleExitMin: 30,
  allowedSenders: [],
  // OFF by default — topic mode activates only when the operator opts in (the routing half
  // ships before the spawn executor, so an accidental opt-in must not break the flat path).
  topics: false,
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

// A Telegram VOICE note (OGG/OPUS) or an audio note. Both carry a file_id we
// resolve via getFile, then download → ffmpeg → Whisper → text (inbound STT).
export interface TgVoice {
  file_id: string;
  duration?: number; // seconds
  mime_type?: string; // usually audio/ogg
  file_size?: number;
}

// The user's partial selection when replying (Bot API 7.0+): the substring of
// the replied-to message they highlighted. Forwarded verbatim into the agent.
export interface TgTextQuote {
  text: string;
}

// A forum topic service message (Bot API 6.3+). `forum_topic_created` carries the new
// topic's name; closed/reopened carry no extra fields. The owning message's
// `message_thread_id` IS the topic id. See docs/specs/tg-forum-topics.md.
export interface TgForumTopicCreated {
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
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
  voice?: TgVoice; // a voice note (OGG/OPUS) — transcribed to text inbound
  audio?: TgVoice; // an audio file/note — same transcribe path as voice
  reply_to_message?: TgMessage; // the message this one replies to (items 2,3)
  quote?: TgTextQuote; // the user's partial-quote selection from it (item 2)
  // --- forum topics (docs/specs/tg-forum-topics.md) ---
  message_thread_id?: number; // the topic id; absent in General / non-forum chats
  is_topic_message?: boolean; // true for a user message inside a topic
  forum_topic_created?: TgForumTopicCreated; // service msg: a new topic was created
  forum_topic_edited?: { name?: string; icon_custom_emoji_id?: string }; // service msg: topic renamed/re-iconed
  forum_topic_closed?: Record<string, never>; // service msg: topic closed (empty object)
  forum_topic_reopened?: Record<string, never>; // service msg: topic reopened (empty object)
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: {
    message_id: number;
    chat: { id: number };
    date: number;
  };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// --- update step function (spec §16 module 4) ---

// Actions are data; the entrypoint executes them in order.
export type Action =
  | { kind: 'inject-text'; text: string } // already wrapped (or verbatim /cmd passthrough)
  | { kind: 'inject-key'; key: 'Escape' } // /stop
  | { kind: 'kill-agent' } // /kill — SIGINT to the registered pane's agent pid
  | { kind: 'status' } // /status — entrypoint composes the reply
  // /agent [<win>] <msg> — entrypoint discovers panes, fuzzy-matches the window
  // (phonetic), routes <msg> to that agent or asks via session-grouped buttons.
  | { kind: 'agent-route'; selector: string | null; rest: string; all: string; from: string }
  // A tap on a /agent selection button (tga:<token>:<index>): the entrypoint
  // looks up the pending message + candidate and injects it into the chosen pane.
  | {
      kind: 'agent-callback';
      callbackQueryId: string;
      token: string;
      index: number;
      from: string;
      messageId: number | null;
    }
  // A reply: route by the recognized origin pane (routes map) when known, else
  // a session-grouped picker ordered LRU/MRU. injectText is already wrapped +
  // carries the quote anchor (items 2,3); it is injected verbatim.
  | { kind: 'reply-route'; replyToMessageId: number; injectText: string; from: string }
  | { kind: 'reply'; text: string } // sendMessage back to the chat
  | { kind: 'answer-callback'; callbackQueryId: string; text: string }
  // messageId is the Telegram message the tapped button belongs to (null when
  // Telegram omits it); the daemon rejects taps whose message does not match
  // the pending prompt, so a stale tap can never answer a later same-key hook.
  | {
      kind: 'answer-question';
      callbackQueryId: string;
      requestId: string;
      value: string;
      messageId: number | null;
    }
  // Delivery receipt: set a 👀 reaction on the source message IF every action
  // emitted for it succeeded. Follows the message's delivery action(s); never
  // emitted for pure error replies (those ARE the failure signal).
  | { kind: 'ack'; messageId: number }
  | {
      kind: 'download-media';
      fileId: string;
      suggestedName: string; // daemon-chosen: <update_id>.<ext>
      mediaKind: 'photo' | 'document';
      fileSize?: number;
      caption?: string;
      from: string; // display name for the wrap
      messageId: number; // inbound Telegram message_id → surfaced as `#<id>` for tg --reply-to
    }
  // A voice/audio note: download the OGG, ffmpeg→WAV, run local Whisper, then
  // route the transcript EXACTLY like a typed message — wrapped + acked. When
  // the note is a reply (replyToMessageId set) it routes through the same
  // reply-route path a typed reply uses (origin-pane recognition + quote
  // anchor); otherwise it injects into the discovered pane like plain text. The
  // entrypoint, not the step function, knows whether Whisper is configured: an
  // unconfigured note becomes an onboarding reply there, never a silent drop.
  | {
      kind: 'transcribe-voice';
      fileId: string;
      suggestedName: string; // daemon-chosen: <update_id>.ogg
      fileSize?: number;
      from: string; // display name for the wrap
      messageId: number; // inbound Telegram message_id → surfaced as `#<id>` for tg --reply-to
      // Set when the voice note itself is a reply: route via reply-route with
      // this quote anchor prepended (built from the replied-to message).
      replyToMessageId?: number;
      replyAnchor?: string;
    }
  // --- forum topics (docs/specs/tg-forum-topics.md) ---
  // A new topic was created → start the per-topic /new flow (ask path, then model).
  | { kind: 'topic-new'; threadId: number; name: string; from: string }
  // A user message inside a topic still in the /new flow → feed the path/model answer
  // to the state machine. `text` is the raw user text (a path, or unused once buttons land).
  | { kind: 'topic-answer'; threadId: number; text: string; from: string; messageId: number }
  // A user message inside a BOUND topic → inject into that topic's pane. injectText is
  // already wrapped; the entrypoint maps threadId→paneId and threads the ack with threadId.
  | { kind: 'topic-route'; threadId: number; injectText: string; from: string; messageId: number }
  // Topic closed / reopened service messages → mark the binding (entrypoint persists).
  | { kind: 'topic-close'; threadId: number }
  | { kind: 'topic-reopen'; threadId: number };

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
  // pane's window NAME (#{window_name}) — the user-set tmux window label
  // ("rig", "3d"). Carried in the core snapshot so the /agent picker labels it
  // reliably (tg-cli#75 fix C); a separate tmux call mis-aligned/blanked under
  // the launchd no-locale tab-mangle. Empty when tmux gives no name.
  windowName: string;
  panePath: string; // pane_current_path
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string; // full command line
}

export type AgentKind = 'claude' | 'opencode' | 'codex' | 'pi' | 'aider' | 'unknown';

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
  socket: string;
  log: string;
  routes: string; // message_id→pane map for reply recognition + LRU/MRU picker
  history: string; // append-only JSONL message log for `tg replies` recall
  topics: string; // threadId→agent binding map for forum-topics mode (always allocated)
}

// --- forum topics (docs/specs/tg-forum-topics.md) ---

// Where a topic is in the per-topic /new lifecycle.
//   awaiting-path  — created; asked for the working directory
//   awaiting-model — got a path; asked for the model
//   bound          — agent spawned + pane bound; messages route here
//   closed         — topic closed or its pane died; re-attaches on reopen/next message
export type TopicStatus = 'awaiting-path' | 'awaiting-model' | 'bound' | 'closed';

// One forum topic's binding to an agent. Persisted as a JSON array (CtlPaths.topics),
// written by the entrypoint on every state transition (same pattern as routes).
export interface TopicBinding {
  threadId: number; // message_thread_id (the topic id)
  name: string; // the topic name (used for the tmux window slug + display)
  status: TopicStatus;
  path?: string; // chosen working directory (set at awaiting-model)
  model?: string; // chosen model id from the catalog (set at spawn)
  paneId?: string; // the spawned tmux pane ("%N"), set at bound
  ts: number; // unix seconds of the last transition
}

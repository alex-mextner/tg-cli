// Inbound voice transcription for tg-ctl (STT, speech→text).
//
// A Telegram VOICE note becomes agent INPUT: the daemon downloads the OGG/OPUS,
// transcodes it to WAV 16 kHz mono with ffmpeg, runs a local Whisper, cleans the
// transcript, then routes the text to the SAME pane a typed reply would reach.
//
// Everything here is PURE — no spawns, no fetch, no file I/O. The tg-ctl
// entrypoint owns the ffmpeg/whisper spawns and the download; this module only
// parses the `voice:` config block, builds the ffmpeg + whisper argv, cleans the
// raw whisper stdout, and decides the onboarding state. The `tg` CLI owns the
// interactive `tg voice setup` discovery.

// --- config (the `voice:` block in ~/.config/tg-cli/config.yaml) ---

// Which local Whisper runner the daemon shells out to. 'whisper.cpp' is the
// native arm64 binary (dependency-free, OGG-capable); 'faster-whisper' shells a
// venv python. Default = whisper.cpp once a model+binary is discovered.
export type WhisperRunner = 'whisper.cpp' | 'faster-whisper';

export interface VoiceConfig {
  // Master switch. OFF until `tg voice setup` (or the auto-onboarding) writes a
  // working binary+model — an unconfigured voice note triggers onboarding, it is
  // never silently dropped.
  enabled: boolean;
  runner: WhisperRunner;
  // whisper.cpp: the whisper-cli (or legacy `main`) executable.
  // faster-whisper: the venv python that imports faster_whisper.
  binPath: string;
  // whisper.cpp: a ggml-*.bin model file path.
  // faster-whisper: a model SIZE token ('large-v3', 'base', …) or a CT2 dir.
  modelPath: string;
  // BCP-47-ish language token or 'auto'. Default 'auto' (ru+en covered).
  language: string;
}

export const DEFAULT_VOICE: VoiceConfig = {
  enabled: false,
  runner: 'whisper.cpp',
  binPath: '',
  modelPath: '',
  language: 'auto',
};

const TRUE_TOKENS = new Set(['true', 'yes', 'on', '1']);
const FALSE_TOKENS = new Set(['false', 'no', 'off', '0']);
const RUNNERS = new Set<string>(['whisper.cpp', 'faster-whisper']);

const unquote = (s: string): string => s.replace(/^["']|["']$/g, '');

// Parse the top-level `voice:` block. Same hand-rolled one-level reader as
// config.ts (parseControlConfig) — no yaml dependency. Anything outside the
// exact `voice:` / `  key: value` shape is ignored.
export function parseVoiceConfig(yaml: string): Partial<VoiceConfig> {
  const out: Partial<VoiceConfig> = {};
  let inVoice = false;
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inVoice = line.trim().replace(/:.*$/, '') === 'voice';
      continue;
    }
    if (!inVoice) continue;

    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = unquote(trimmed.slice(0, colon).trim());
    const value = trimmed.slice(colon + 1).trim();
    if (!value) continue;

    switch (key) {
      case 'enabled': {
        // Unquote before the token test so a quoted `enabled: "true"` /
        // `enabled: "false"` is honored, not silently ignored — important here
        // because a quoted "false" must still register as the explicit opt-out.
        const v = unquote(value).toLowerCase();
        if (TRUE_TOKENS.has(v)) out.enabled = true;
        else if (FALSE_TOKENS.has(v)) out.enabled = false;
        break;
      }
      case 'runner':
        out.runner = unquote(value) as WhisperRunner; // resolve normalizes garbage
        break;
      case 'bin_path':
        out.binPath = unquote(value);
        break;
      case 'model_path':
        out.modelPath = unquote(value);
        break;
      case 'language':
        out.language = unquote(value);
        break;
    }
  }
  return out;
}

// Merge a parsed partial over the defaults, healing invalid values: a runner
// outside the union → 'whisper.cpp'; an empty language → 'auto'.
export function resolveVoiceConfig(partial: Partial<VoiceConfig>): VoiceConfig {
  return {
    enabled: partial.enabled ?? DEFAULT_VOICE.enabled,
    runner: partial.runner !== undefined && RUNNERS.has(partial.runner) ? partial.runner : DEFAULT_VOICE.runner,
    binPath: partial.binPath ?? DEFAULT_VOICE.binPath,
    modelPath: partial.modelPath ?? DEFAULT_VOICE.modelPath,
    language: (partial.language && partial.language.trim()) || DEFAULT_VOICE.language,
  };
}

// Serialize back to the `voice:` config block (for `tg voice setup` to persist).
// Quoted scalars so paths with spaces survive the one-level reader.
export function renderVoiceConfigBlock(cfg: VoiceConfig): string {
  return [
    'voice:',
    `  enabled: ${cfg.enabled ? 'true' : 'false'}`,
    `  runner: ${cfg.runner}`,
    `  bin_path: "${cfg.binPath}"`,
    `  model_path: "${cfg.modelPath}"`,
    `  language: ${cfg.language}`,
    '',
  ].join('\n');
}

// Replace the top-level `voice:` block (and its indented children) in an
// existing config.yaml with a fresh rendering, or append one when absent. Other
// top-level blocks are preserved verbatim. A top-level line has zero leading
// whitespace; the block ends at the next such line (blank lines inside the block
// keep the scan going). Pure — config round-trip is tested through this.
export function upsertVoiceBlock(yaml: string, cfg: VoiceConfig): string {
  const block = renderVoiceConfigBlock(cfg);
  const lines = yaml.split('\n');
  const startIdx = lines.findIndex((l) => l.length === l.trimStart().length && /^voice:\s*$/.test(l));
  if (startIdx === -1) {
    const sep = yaml.length === 0 || yaml.endsWith('\n') ? '' : '\n';
    return `${yaml}${sep}${block}`;
  }
  let end = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (l.length === l.trimStart().length) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, startIdx).join('\n');
  const after = lines.slice(end).join('\n');
  return `${before === '' ? '' : `${before}\n`}${block}${after}`;
}

// A voice note is configured iff enabled AND both paths are non-empty. The
// entrypoint additionally checks the files exist on disk before transcribing;
// this is the cheap config-level gate the step function uses to decide whether
// to emit a transcribe action or an onboarding reply.
export function isVoiceConfigured(cfg: VoiceConfig): boolean {
  return cfg.enabled && cfg.binPath.trim() !== '' && cfg.modelPath.trim() !== '';
}

// --- ffmpeg transcode (OGG/OPUS → WAV 16 kHz mono PCM, what Whisper wants) ---

export function buildFfmpegArgv(inputPath: string, wavPath: string): string[] {
  // -y overwrite, -ar 16000 sample rate, -ac 1 mono, -f wav. -nostdin so a
  // spawned ffmpeg never steals the daemon's stdin. -loglevel error keeps the
  // daemon log clean.
  return [
    'ffmpeg',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-f',
    'wav',
    wavPath,
  ];
}

// --- whisper transcribe argv (runner-specific) ---

// whisper.cpp: emit clean text to STDOUT — `-nt` (no timestamps), `-np` (no
// prints / no banner), language token, `-f <wav>`. We do NOT use `-otxt` (that
// writes a sidecar file); stdout is enough and avoids a temp-file dance.
export function buildWhisperCppArgv(cfg: VoiceConfig, wavPath: string): string[] {
  return [cfg.binPath, '-m', cfg.modelPath, '-f', wavPath, '-l', cfg.language, '-nt', '-np'];
}

// Self-contained faster-whisper transcriber the daemon writes to the config dir
// when the probed venv ships no project script. Reads --input_audio / --model /
// optional --language, prints plain segment text to stdout (cleanTranscript
// handles the rest). Kept minimal + dependency-light (only faster_whisper, which
// the venv already has by definition).
export const FASTER_WHISPER_FALLBACK_SCRIPT = `import argparse
from faster_whisper import WhisperModel

ap = argparse.ArgumentParser()
ap.add_argument("--input_audio", required=True)
ap.add_argument("--model", default="large-v3")
ap.add_argument("--language", default=None)
a = ap.parse_args()

model = WhisperModel(a.model, device="cpu", compute_type="int8")
segments, _ = model.transcribe(a.input_audio, language=a.language, beam_size=5)
for s in segments:
    print(s.text.strip())
`;

// faster-whisper: run the project's transcriber via the venv python. We pass the
// model size, language and the wav; the script prints `text` lines we then clean.
// The runner script path is derived from the configured python's project dir by
// the entrypoint; here we just assemble the argv given an explicit script path.
export function buildFasterWhisperArgv(
  pythonBin: string,
  scriptPath: string,
  cfg: VoiceConfig,
  wavPath: string,
): string[] {
  const argv = [pythonBin, scriptPath, '--input_audio', wavPath, '--model', cfg.modelPath];
  if (cfg.language && cfg.language !== 'auto') argv.push('--language', cfg.language);
  return argv;
}

// --- transcript cleaning ---

// whisper.cpp with `-nt -np` still occasionally prefixes a `[blank_audio]`,
// `[silence]`, `(...)` artefact and emits leading/trailing whitespace and
// CR/newlines. faster-whisper's plain `--input_audio` script prints one line per
// segment, sometimes with a `[0.00s -> 1.20s]` timestamp prefix and a leading
// "Detected language ..." banner. This collapses all of that to one clean line.
const TIMESTAMP_PREFIX_RE = /^\s*\[\s*\d+(?:\.\d+)?s?\s*->\s*\d+(?:\.\d+)?s?\s*\]\s*/;
const BRACKET_NOISE_RE = /\[(?:_*blank_*audio_*|silence|music|inaudible|noise|sound)\]/gi;
const PAREN_NOISE_RE = /\((?:blank_?audio|silence|music|inaudible|noise)\)/gi;

export function cleanTranscript(raw: string): string {
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/\r/g, ''))
    // drop faster-whisper's diagnostic banners; keep real segments.
    .filter((l) => !/^\s*(Detected language|Using (CPU|CUDA) device)\b/i.test(l))
    .map((l) => l.replace(TIMESTAMP_PREFIX_RE, ''))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return lines.join(' ').replace(BRACKET_NOISE_RE, ' ').replace(PAREN_NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
}

// --- onboarding discovery (pure: given probe inputs, decide the verdict) ---

// What the entrypoint/CLI finds when probing the host for a Whisper install.
export interface WhisperProbe {
  // whisper.cpp candidates discovered under ~/xp (or wherever): an executable
  // path that exists and is a file, plus the ggml models found next to it.
  whisperCppBin?: string;
  whisperCppModels?: string[]; // ggml-*.bin paths, real models only
  // faster-whisper candidates: a venv python that imports faster_whisper + the
  // runner script path.
  fasterWhisperPython?: string;
  fasterWhisperScript?: string;
  ffmpegFound: boolean;
}

export type OnboardingVerdict =
  | { kind: 'ready'; cfg: VoiceConfig } // a runner+model was found — persist & enable
  | { kind: 'need-ffmpeg' } // a Whisper exists but ffmpeg is missing
  | { kind: 'need-install'; hint: string }; // nothing found — guide the user

// Pick the best model from a list of ggml-*.bin paths. Prefer a real multilingual
// model (large/medium/small without `.en`) over an English-only one over the
// tiny test fixtures, so an auto/ru voice note transcribes correctly. Excludes
// the `for-tests-` fixtures whisper.cpp ships (they are not real weights).
export function pickWhisperCppModel(models: string[]): string | undefined {
  const real = models.filter((m) => !/(^|\/)for-tests-/.test(m));
  if (real.length === 0) return undefined;
  const score = (m: string): number => {
    const base = m.toLowerCase();
    // `.en` as a language segment marks an English-only model. It can be followed
    // by the extension (`ggml-base.en.bin`) OR a quantization/variant suffix
    // (`ggml-medium.en-q5_0.bin`, `ggml-small.en-tdrz.bin`) — match `.en` then a
    // `.` or `-` boundary, not only `.en.bin`.
    const multilingual = !/\.en(?=[.\-])/.test(base);
    let size = 0;
    if (base.includes('large')) size = 4;
    else if (base.includes('medium')) size = 3;
    else if (base.includes('small')) size = 2;
    else if (base.includes('base')) size = 1;
    // multilingual is the dominant factor (ru+en default); size breaks ties.
    return (multilingual ? 100 : 0) + size;
  };
  return [...real].sort((a, b) => score(b) - score(a))[0];
}

// Decide the onboarding verdict from a probe + the requested language. Pure, so
// both the auto-prompt (daemon side) and `tg voice setup` (CLI side) share it.
export function decideOnboarding(probe: WhisperProbe, language = 'auto'): OnboardingVerdict {
  const haveWhisperCpp =
    Boolean(probe.whisperCppBin) && pickWhisperCppModel(probe.whisperCppModels ?? []) !== undefined;
  // faster-whisper needs only the venv python — a project script is preferred
  // but optional, because the daemon writes a generated fallback transcriber
  // script (FASTER_WHISPER_FALLBACK_SCRIPT) when the project ships none.
  const haveFaster = Boolean(probe.fasterWhisperPython);

  if (!haveWhisperCpp && !haveFaster) {
    return {
      kind: 'need-install',
      hint: 'No local Whisper found. Build whisper.cpp (https://github.com/ggml-org/whisper.cpp) and download a ggml model, or set up faster-whisper, then run `tg voice setup`.',
    };
  }
  if (!probe.ffmpegFound) return { kind: 'need-ffmpeg' };

  if (haveWhisperCpp) {
    return {
      kind: 'ready',
      cfg: resolveVoiceConfig({
        enabled: true,
        runner: 'whisper.cpp',
        binPath: probe.whisperCppBin,
        modelPath: pickWhisperCppModel(probe.whisperCppModels ?? []),
        language,
      }),
    };
  }
  return {
    kind: 'ready',
    cfg: resolveVoiceConfig({
      enabled: true,
      runner: 'faster-whisper',
      binPath: probe.fasterWhisperPython,
      modelPath: 'large-v3',
      language,
    }),
  };
}

// The reply text the bot sends when an unconfigured voice note arrives, or when
// `tg voice setup` reports its result. Kept here so the message is tested and
// identical on both paths.
export function onboardingMessage(verdict: OnboardingVerdict): string {
  switch (verdict.kind) {
    case 'ready':
      return [
        '🎙️ Voice transcription is now configured.',
        `runner: ${verdict.cfg.runner}`,
        `model: ${verdict.cfg.modelPath}`,
        `language: ${verdict.cfg.language}`,
        'Send a voice note — it will be transcribed and routed to your agent.',
      ].join('\n');
    case 'need-ffmpeg':
      return [
        '🎙️ A local Whisper was found, but `ffmpeg` is missing.',
        'Install it (`brew install ffmpeg`), then run `tg voice setup`.',
      ].join('\n');
    case 'need-install':
      return ['🎙️ Voice input is not set up yet.', verdict.hint].join('\n');
  }
}

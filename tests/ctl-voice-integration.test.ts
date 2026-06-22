import { afterAll, expect, test } from 'bun:test';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';

// Full inbound-VOICE round-trip against a Bot-API fake (mirrors
// ctl-daemon-integration.test.ts). The Whisper + ffmpeg binaries are PATH shims
// (a fixture transcript, no real model needed); tmux is shimmed to report ONE
// pane that hosts a `claude` agent (ps shim agrees), so the transcribed text is
// actually INJECTED and we capture it from the tmux shim log — proving voice
// routes exactly like a typed message. A SECOND daemon run with no voice config
// proves the unconfigured note triggers the onboarding reply instead of a drop.

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');
const nowSec = Math.floor(Date.now() / 1000);
const TRANSCRIPT = 'add a retry to the upload handler';

// A single voice note from the allowed sender.
const QUEUE_CONFIGURED = [
  {
    update_id: 200,
    message: {
      message_id: 10,
      from: { id: 1, first_name: 'Alex' },
      chat: { id: 1 },
      date: nowSec,
      voice: { file_id: 'voice-xyz', duration: 4, mime_type: 'audio/ogg', file_size: 4096 },
    },
  },
];

function makeServer(queue: typeof QUEUE_CONFIGURED) {
  const state = {
    offsets: [] as number[],
    sent: [] as { chat_id: number; text: string }[],
    fetchedFileId: null as string | null,
    fileDownloaded: false,
    serveCount: 0,
    // When set, the queue is withheld until the test flips it true. Lets a test
    // configure the daemon BEFORE the (at-most-once) note is ever delivered.
    releaseQueue: true,
    // When set, getFile returns a non-JSON body so the daemon's `.json()` throws.
    brokenGetFile: false,
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/getUpdates')) {
        const offset = Number(url.searchParams.get('offset') ?? '0');
        state.offsets.push(offset);
        const pending = state.releaseQueue ? queue.filter((u) => u.update_id >= offset) : [];
        if (pending.length) {
          state.serveCount += 1;
          return Response.json({ ok: true, result: pending });
        }
        await Bun.sleep(1200);
        return Response.json({ ok: true, result: [] });
      }
      if (url.pathname.endsWith('/sendMessage')) {
        state.sent.push((await req.json()) as { chat_id: number; text: string });
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      if (url.pathname.endsWith('/setMessageReaction')) {
        return Response.json({ ok: true, result: true });
      }
      if (url.pathname.endsWith('/getFile')) {
        state.fetchedFileId = url.searchParams.get('file_id');
        // brokenGetFile: a non-JSON body so the daemon's `.json()` THROWS — the
        // download helper must catch it (not lose the note + crash the loop).
        if (state.brokenGetFile) return new Response('<html>502 bad gateway</html>');
        return Response.json({ ok: true, result: { file_path: 'voice/file_0.oga' } });
      }
      if (url.pathname.startsWith('/file/bot')) {
        state.fileDownloaded = true;
        return new Response('OGGOPUSBYTES');
      }
      return Response.json({ ok: false, description: `unexpected: ${url.pathname}` }, { status: 404 });
    },
  });
  return { server, state };
}

// Build a config dir with shimmed ffmpeg + whisper-cli + tmux + ps. The whisper
// shim ignores its args and prints the fixture transcript with whisper-style
// noise to prove cleaning; ffmpeg just `touch`es the output wav (the daemon
// checks it exists). tmux/ps shims describe ONE claude-hosting pane.
// voiceMode: 'configured' (enabled + paths), 'disabled' (paths but
// enabled:false — the master opt-out), 'absent' (no voice block at all),
// 'stale-faster' (enabled faster-whisper whose CT2 model dir does not exist).
function makeCfgDir(opts: {
  voiceMode: 'configured' | 'disabled' | 'absent' | 'stale-faster';
  withFfmpeg?: boolean;
  slowMs?: number;
}): {
  cfgDir: string;
  shimDir: string;
  tmuxLog: string;
  whisperBin: string;
  modelPath: string;
} {
  const withFfmpeg = opts.withFfmpeg ?? true;
  const cfgDir = mkdtempSync(join(tmpdir(), 'tgctl-voice-'));
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123:abc\nTG_CHAT_ID=1\n');

  const shimDir = join(cfgDir, 'bin');
  mkdirSync(shimDir);

  // ffmpeg: parse `-i <in>` ... `<out>` (out is the last argv) and create it.
  // Omitted in the missing-ffmpeg test (the daemon runs with an isolated PATH
  // so the real ffmpeg is invisible — Bun.spawnSync throws ENOENT, which the
  // fix must catch into a failure reply rather than a lost note).
  if (withFfmpeg) {
    writeFileSync(
      join(shimDir, 'ffmpeg'),
      [
        '#!/bin/sh',
        'out=""',
        'for a in "$@"; do out="$a"; done', // last arg = output wav
        ': > "$out"',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );
  }

  // whisper-cli: print the fixture transcript wrapped in whisper-style noise so
  // cleanTranscript has something to strip. Args ignored. slowMs simulates a
  // long transcription so the test can prove the daemon stays responsive (the
  // event loop must keep servicing other messages while whisper runs).
  const whisperBin = join(shimDir, 'whisper-cli');
  const sleepLine = opts.slowMs ? `sleep ${(opts.slowMs / 1000).toFixed(2)}\n` : '';
  writeFileSync(whisperBin, `#!/bin/sh\n${sleepLine}printf '[BLANK_AUDIO]\\n  ${TRANSCRIPT}  \\n'\nexit 0\n`, {
    mode: 0o755,
  });

  // A throwaway "model" file so voiceReady's existsSync passes.
  const modelPath = join(cfgDir, 'ggml-large-v3.bin');
  writeFileSync(modelPath, 'FAKEMODEL');

  // tmux shim: list-panes → one pane (pid 4242, claude); send-keys/load-buffer/
  // paste-buffer → log argv; everything else exits 0.
  const tmuxLog = join(cfgDir, 'tmux-calls.log');
  writeFileSync(
    join(shimDir, 'tmux'),
    [
      '#!/bin/sh',
      `echo "$@" >> '${tmuxLog}'`,
      'case "$1" in',
      '  list-panes)',
      // session\twindow\tpane\tpid\tcommand\twindow_name\tpath
      `    printf 'work\\t0\\t%%1\\t4242\\t2.1.150\\twork\\t/tmp/proj\\n' ;;`,
      '  *) : ;;',
      'esac',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );

  // ps shim: report the claude process as pane_pid 4242 so findAgentInPane
  // matches. Format: `pid ppid command`.
  writeFileSync(join(shimDir, 'ps'), ['#!/bin/sh', "printf '4242 1 claude\\n'", 'exit 0'].join('\n'), { mode: 0o755 });

  const block = (enabled: boolean): string =>
    [
      'voice:',
      `  enabled: ${enabled ? 'true' : 'false'}`,
      '  runner: whisper.cpp',
      `  bin_path: "${whisperBin}"`,
      `  model_path: "${modelPath}"`,
      '  language: auto',
      '',
    ].join('\n');
  // faster-whisper pointed at a CT2 model DIRECTORY that does not exist on disk.
  const staleFasterBlock = [
    'voice:',
    '  enabled: true',
    '  runner: faster-whisper',
    `  bin_path: "${whisperBin}"`, // any existing executable; voiceReady checks bin existence
    `  model_path: "${join(cfgDir, 'ct2-model-GONE')}"`, // a path (has a slash) that does NOT exist
    '  language: auto',
    '',
  ].join('\n');
  const voiceBlock =
    opts.voiceMode === 'configured'
      ? block(true)
      : opts.voiceMode === 'disabled'
        ? block(false)
        : opts.voiceMode === 'stale-faster'
          ? staleFasterBlock
          : '';
  writeFileSync(join(cfgDir, 'config.yaml'), `control:\n  enabled: true\n${voiceBlock}`);

  return { cfgDir, shimDir, tmuxLog, whisperBin, modelPath };
}

const procs: Subprocess[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];

afterAll(async () => {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill(9);
      await p.exited;
    }
  }
  for (const s of servers) s.stop(true);
});

async function runDaemon(
  cfgDir: string,
  shimDir: string,
  apiBase: string,
  opts: { isolatePath?: boolean } = {},
): Promise<Subprocess> {
  const logFd = openSync(join(cfgDir, 'daemon.log'), 'a');
  // Default: shimDir FIRST so the fake tmux/ps/ffmpeg/whisper win over the real
  // ones. isolatePath: ONLY shimDir, so a binary not shimmed (ffmpeg in the
  // missing-ffmpeg test) is genuinely absent and the spawn throws ENOENT.
  const PATH = opts.isolatePath ? shimDir : `${shimDir}:${process.env.PATH ?? ''}`;
  const daemon = Bun.spawn([process.execPath, TG_CTL, 'run'], {
    env: { PATH, HOME: cfgDir, TG_CTL_CONFIG_DIR: cfgDir, TG_API_BASE: apiBase },
    stdio: ['ignore', logFd, logFd],
  });
  procs.push(daemon);
  closeSync(logFd);
  return daemon;
}

test('configured voice note → downloaded, transcribed, transcript injected into the agent pane', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  const { cfgDir, shimDir, tmuxLog } = makeCfgDir({ voiceMode: 'configured' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // The voice file was resolved + downloaded.
  expect(state.fetchedFileId).toBe('voice-xyz');
  expect(state.fileDownloaded).toBe(true);

  // The OGG was saved under the daemon-chosen name <update_id>.ogg.
  const saved = join(cfgDir, '.cache', 'tg-cli', 'inbound', '200.ogg');
  expect(readFileSync(saved, 'utf8')).toBe('OGGOPUSBYTES');

  // The CLEANED transcript (noise stripped, trimmed) was injected into the agent pane
  // as a 🎤-marked quote — proving voice routes like typed text but is visibly tagged
  // as transcribed speech.
  const tmuxCalls = readFileSync(tmuxLog, 'utf8');
  expect(tmuxCalls).toContain('list-panes'); // discovery ran through the shim
  // The wrap carries the inbound message_id as `tg#10` (the message-ref
  // convention, tg#28) so the agent can answer with `tg --reply-to 10`
  // (threaded replies) and quote the ref back without colliding with a #N PR.
  expect(tmuxCalls).toContain(`[TG from Alex tg#10] 🎤 «${TRANSCRIPT}»`);
  // The whisper noise marker must NOT survive into the injected text.
  expect(tmuxCalls).not.toContain('BLANK_AUDIO');

  // No error reply was sent (the inject succeeded).
  expect(state.sent.some((m) => /failed|no agent|not set up/i.test(m.text))).toBe(false);

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('unconfigured voice note → onboarding reply, never silently dropped', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  const { cfgDir, shimDir } = makeCfgDir({ voiceMode: 'absent' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.sent.length >= 1 && state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // A guided onboarding message was sent back to the user (🎙️ marker), and the
  // voice file was NOT downloaded (we short-circuit before getFile).
  const onboarding = state.sent.find((m) => m.text.includes('🎙️'));
  expect(onboarding).toBeDefined();
  expect(state.fetchedFileId).toBeNull();

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('configured voice but ffmpeg MISSING → failure reply, daemon survives, offset advances', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // configured=true (whisper-cli + model present), withFfmpeg=false, and an
  // ISOLATED PATH so the real ffmpeg is invisible → spawn throws ENOENT, which
  // the fix must catch into a "transcription failed" reply (not a lost note +
  // dead daemon).
  const { cfgDir, shimDir } = makeCfgDir({ voiceMode: 'configured', withFfmpeg: false });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`, { isolatePath: true });

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.sent.length >= 1 && state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // The note reached transcription (download happened), then ffmpeg failed → a
  // failure reply went back instead of the note vanishing.
  expect(state.fetchedFileId).toBe('voice-xyz');
  expect(state.sent.some((m) => /transcription failed/i.test(m.text))).toBe(true);
  // The daemon survived the missing-binary spawn (offset advanced past it).
  expect(state.offsets).toContain(201);
  expect(daemon.exitCode).toBeNull(); // still running, not crashed

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('voice.enabled: false → note dropped silently (no transcribe, no onboarding reply)', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // A discoverable Whisper IS present (paths set), but the user opted out.
  const { cfgDir, shimDir, tmuxLog } = makeCfgDir({ voiceMode: 'disabled' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }
  await Bun.sleep(400); // let any (wrong) reply/inject surface

  // The master switch held: nothing downloaded, nothing transcribed/injected,
  // and NO onboarding reply (that would re-prompt a user who opted out).
  expect(state.fetchedFileId).toBeNull();
  expect(state.sent).toHaveLength(0);
  expect(readFileSync(tmuxLog, 'utf8')).not.toContain('send-keys');

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('voice config written AFTER the daemon started is reloaded per note (no restart needed)', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // Boot the daemon with NO voice block and the note WITHHELD; write the
  // configured block while it is up, then release the note. The reload-per-note
  // logic must pick up the mid-run config without a restart.
  state.releaseQueue = false;
  const { cfgDir, shimDir, tmuxLog, whisperBin, modelPath } = makeCfgDir({ voiceMode: 'absent' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  // Give the daemon a moment to boot with the empty config, THEN configure +
  // release the note (so it is delivered only after voice is set up on disk).
  await Bun.sleep(800);
  writeFileSync(
    join(cfgDir, 'config.yaml'),
    [
      'control:',
      '  enabled: true',
      'voice:',
      '  enabled: true',
      '  runner: whisper.cpp',
      `  bin_path: "${whisperBin}"`,
      `  model_path: "${modelPath}"`,
      '  language: auto',
      '',
    ].join('\n'),
  );
  state.releaseQueue = true;

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (readFileSync(tmuxLog, 'utf8').includes(TRANSCRIPT)) break;
    await Bun.sleep(150);
  }

  // The transcript was injected even though the daemon booted unconfigured —
  // proving the per-note config reload picked up the mid-run `tg voice setup`.
  expect(readFileSync(tmuxLog, 'utf8')).toContain(`[TG from Alex tg#10] 🎤 «${TRANSCRIPT}»`);
  expect(state.fetchedFileId).toBe('voice-xyz');

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('configured voice but getFile returns garbage → failure reply, daemon survives, no lost note', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  state.brokenGetFile = true; // non-JSON body → `.json()` throws inside the helper
  const { cfgDir, shimDir } = makeCfgDir({ voiceMode: 'configured' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.sent.length >= 1 && state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // The throw was caught → a "media download failed" reply went back, the offset
  // advanced, and the daemon is still alive (the bug would crash the poll loop
  // body and lose the note with no reply).
  expect(state.fetchedFileId).toBe('voice-xyz');
  expect(state.sent.some((m) => /download failed/i.test(m.text))).toBe(true);
  expect(state.offsets).toContain(201);
  expect(daemon.exitCode).toBeNull();

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('faster-whisper with a missing CT2 model dir → onboarding, note NOT downloaded', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // enabled faster-whisper, but model_path is a directory path that does not
  // exist → voiceReady must fail the artifact gate and fall back to onboarding
  // instead of downloading and failing deep inside Python.
  const { cfgDir, shimDir } = makeCfgDir({ voiceMode: 'stale-faster' });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);

  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    if (state.sent.length >= 1 && state.offsets.includes(201)) break;
    await Bun.sleep(100);
  }

  // Onboarding reply (🎙️) and NO download — the stale model never reaches Python.
  expect(state.sent.some((m) => m.text.includes('🎙️'))).toBe(true);
  expect(state.fetchedFileId).toBeNull();

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 20_000);

test('daemon stays responsive (socket accepts) DURING a slow transcription — async spawn frees the event loop', async () => {
  const { server, state } = makeServer(QUEUE_CONFIGURED);
  servers.push(server);
  // A 3s whisper. With the old blocking spawnSync the daemon's event loop would
  // be frozen for those 3s and the Unix control socket could not accept a
  // connection; with async Bun.spawn the socket server keeps servicing.
  const { cfgDir, shimDir, tmuxLog } = makeCfgDir({ voiceMode: 'configured', slowMs: 3000 });
  const daemon = await runDaemon(cfgDir, shimDir, `http://127.0.0.1:${server.port}`);
  const sockPath = join(cfgDir, 'tg-ctl.123.sock');

  // Wait until transcription has STARTED: the OGG was downloaded (getFile fired)
  // but the transcript is not yet injected (whisper still sleeping).
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (state.fetchedFileId === 'voice-xyz' && !readFileSync(tmuxLog, 'utf8').includes(TRANSCRIPT)) break;
    await Bun.sleep(50);
  }
  expect(state.fetchedFileId).toBe('voice-xyz'); // transcription is in flight

  // While whisper sleeps, the daemon's control socket must still ACCEPT — proof
  // the event loop is not blocked. (We don't speak the protocol; a clean connect
  // is enough.) Retry briefly in case the socket file is mid-creation.
  const connected = await new Promise<boolean>((resolve) => {
    const tryConnect = (attemptsLeft: number): void => {
      if (!existsSync(sockPath)) {
        if (attemptsLeft <= 0) return resolve(false);
        setTimeout(() => tryConnect(attemptsLeft - 1), 100);
        return;
      }
      const c = createConnection(sockPath);
      const onDone = (ok: boolean): void => {
        c.destroy();
        resolve(ok);
      };
      c.once('connect', () => onDone(true));
      c.once('error', () => {
        if (attemptsLeft <= 0) return onDone(false);
        setTimeout(() => tryConnect(attemptsLeft - 1), 100);
      });
      c.setTimeout(1500, () => onDone(false));
    };
    tryConnect(15); // ~1.5s of retries, all WITHIN the 3s whisper sleep
  });
  expect(connected).toBe(true);

  // And the transcription still completes correctly afterwards.
  const t1 = Date.now();
  while (Date.now() - t1 < 8000) {
    if (readFileSync(tmuxLog, 'utf8').includes(TRANSCRIPT)) break;
    await Bun.sleep(100);
  }
  expect(readFileSync(tmuxLog, 'utf8')).toContain(`[TG from Alex tg#10] 🎤 «${TRANSCRIPT}»`);

  daemon.kill('SIGTERM');
  await Promise.race([daemon.exited, Bun.sleep(4000)]);
}, 25_000);

// --- `tg-ctl voice-setup` CLI exit codes (no Bot API, no daemon) ---

// Build a HOME with a fake whisper.cpp install (executable + a real-looking
// ggml model) so decideOnboarding returns 'ready'. The config dir + ffmpeg on
// PATH are caller-controlled.
function fakeWhisperHome(): { home: string; binDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'tgctl-vsetup-'));
  const wc = join(home, 'xp', 'whisper.cpp');
  mkdirSync(join(wc, 'build', 'bin'), { recursive: true });
  mkdirSync(join(wc, 'models'), { recursive: true });
  writeFileSync(join(wc, 'build', 'bin', 'whisper-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(wc, 'models', 'ggml-large-v3.bin'), 'FAKE');
  // a PATH dir carrying a fake ffmpeg so decideOnboarding sees ffmpegFound.
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { home, binDir };
}

async function runVoiceSetupCli(home: string, binDir: string, configDir: string): Promise<number> {
  const proc = Bun.spawn([process.execPath, TG_CTL, 'voice-setup'], {
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, HOME: home, TG_CTL_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  return proc.exitCode ?? 1;
}

test('tg-ctl voice-setup exits 0 when a Whisper is found and config persists', async () => {
  const { home, binDir } = fakeWhisperHome();
  const configDir = join(home, '.config', 'tg-cli');
  const code = await runVoiceSetupCli(home, binDir, configDir);
  expect(code).toBe(0);
  expect(readFileSync(join(configDir, 'config.yaml'), 'utf8')).toContain('runner: whisper.cpp');
}, 15_000);

test('tg-ctl voice-setup exits NON-ZERO when a ready install cannot be persisted', async () => {
  const { home, binDir } = fakeWhisperHome();
  // A read-only config dir → the write fails → setup must NOT report success.
  const configDir = join(home, '.config', 'tg-cli');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), 'control:\n  enabled: true\n');
  chmodSync(join(configDir, 'config.yaml'), 0o444); // read-only file
  chmodSync(configDir, 0o555); // read-only dir (no create/replace)
  try {
    const code = await runVoiceSetupCli(home, binDir, configDir);
    expect(code).not.toBe(0);
  } finally {
    chmodSync(configDir, 0o755); // restore so afterAll/tmp cleanup works
  }
}, 15_000);

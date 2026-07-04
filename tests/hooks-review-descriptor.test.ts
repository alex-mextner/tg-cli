import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { deflateSync } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';
import { runPreSendPhotoHooks, toolHooksDir, trustFile } from '../features/hooks/run-photo-hooks';
import { invocationDigest } from '../features/hooks/types';

// --- minimal PNG encoder, used ONLY to build a synthetic "full VS Code window"
// screenshot for the HYP-891 regression test below: wide + a dark, uniform
// left-edge strip, matching the pixel signature the now-removed
// `looks_like_vscode_window()` heuristic used to hard-block on.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Build a real, decodable PNG: wide (>=1000px) with the whole frame set to a
 * dark, flat color — the exact "dark uniform activity-bar strip" signature
 * the removed heuristic keyed on (calibrated ~[25,26,27] in its docstring). */
function buildFullWindowLikePng(width = 1200, height = 600): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = pngChunk('IHDR', ihdrData);

  const rowBytes = 1 + width * 3; // filter byte + RGB
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = 25;
      raw[px + 1] = 26;
      raw[px + 2] = 27;
    }
  }
  const idat = pngChunk('IDAT', deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

// End-to-end through the REAL review-side Python executable
// (features/hooks/review-descriptor/pre_send_photo.py), with `review` itself
// MOCKED on PATH so the test never depends on review-cli being installed/fixed.
// This proves the descriptor + executable + tg framework chain.

const REPO = join(import.meta.dir, '..');
const PY_HOOK = join(REPO, 'features', 'hooks', 'review-descriptor', 'pre_send_photo.py');

let home: string;
let binDir: string;
let pngPath: string;
let savedPath: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-review-hook-'));
  binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  pngPath = join(home, 'shot.png');
  writeFileSync(pngPath, 'PNGDATA');
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath}`;
});

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  rmSync(home, { recursive: true, force: true });
});

// Install a fake `review` that emits a fixed visual --json verdict + rc.
function mockReview(jsonVerdict: string, exitCode: number): void {
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\n# fake review visual\ncat <<'JSON'\n${jsonVerdict}\nJSON\nexit ${exitCode}\n`,
  );
  chmodSync(review, 0o755);
}

// Install the review-visual descriptor pointing at the REAL python hook, trusted.
function installDescriptorTrusted(): void {
  const dir = toolHooksDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review-visual.pre-send-photo.json'),
    JSON.stringify({
      id: 'review-visual',
      point: 'pre-send-photo',
      cmd: PY_HOOK,
      timeout_ms: 60000,
      on_error: 'open',
    }),
  );
  const sha = createHash('sha256').update(readFileSync(PY_HOOK)).digest('hex');
  // Invocation digest must mirror the runner: cmd + args + timeout_ms. The
  // descriptor sets timeout_ms: 60000 and no args, so pin the same — otherwise
  // under AGENTS_HOOKS_TRUST=1 the pin reports HOOK CHANGED and quarantines.
  const invSha = createHash('sha256')
    .update(invocationDigest(PY_HOOK, undefined, 60000), 'utf8')
    .digest('hex');
  writeFileSync(
    trustFile(home),
    JSON.stringify({
      'review-visual.pre-send-photo': {
        cmd_sha256: sha,
        invocation_sha256: invSha,
        point: 'pre-send-photo',
        on_error: 'open',
      },
    }),
  );
}

test('review verdict "keep" → send proceeds', () => {
  mockReview('{"decision":"keep","reason":"Styles applied (score 0.85)"}', 0);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'hi' }, process.env, home);
  expect(v.blocked).toBe(false);
});

// HYP-891 regression: a full VS Code WINDOW screenshot (wide + dark, uniform
// left activity-bar strip) must NOT be auto-blocked before `review visual`
// ever runs. `looks_like_vscode_window()` (added 2026-07-01, commit 87b4522)
// hard-blocked exactly this shape, defeating Alex's tg#6041 standard that
// full-window diagnostic proofs (Explorer/Inspector/Logs visible) are the
// DEFAULT desired HyperIDE format; removed 2026-07-03 (HYP-891).
// This asserts BOTH sides of "content-based, not format-based": (a) the
// full-window shot reaches `review visual` at all — proven by capturing its
// argv, not just trusting a mocked verdict — and (b) the surviving gate is
// still a REAL gate: a `rollback` verdict on the very same full-window shape
// still blocks the send.
test('full VS Code WINDOW screenshot (wide, dark left strip) → reaches `review visual`, NOT auto-blocked on format', () => {
  const fullWindowPath = join(home, 'full-window-shot.png');
  writeFileSync(fullWindowPath, buildFullWindowLikePng());
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: fullWindowPath, caption: 'full window proof' }, process.env, home);
  expect(v.blocked).toBe(false);
  // Proves the hook did not short-circuit on shape: `review visual` was
  // actually invoked with THIS full-window image path.
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', fullWindowPath, '--json', '--strict']);
});

// NOTE: this only proves verdict ROUTING still works for a full-window shot
// (rollback -> block()) — it does NOT prove `review visual` can actually
// DETECT a broken/unstyled preview diluted inside a full-window screenshot.
// That detection accuracy is the UNVERIFIED tradeoff called out in the code
// comment above and in HYP-891; no test (short of a real vision-model call)
// can close it here.
test('full VS Code WINDOW screenshot + review verdict "rollback" → still BLOCKED (verdict routing intact)', () => {
  const fullWindowPath = join(home, 'full-window-shot.png');
  writeFileSync(fullWindowPath, buildFullWindowLikePng());
  mockReview('{"decision":"rollback","reason":"Unstyled render (score 0.05)"}', 10);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: fullWindowPath }, process.env, home);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toContain('Unstyled render');
});

test('review visual hook calls canonical review visual argv from the caller cwd', () => {
  const argsFile = join(home, 'review-args.txt');
  const cwdFile = join(home, 'review-cwd.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\npwd > '${cwdFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'hi' }, process.env, home);
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', pngPath, '--json', '--strict']);
  const cwd = readFileSync(cwdFile, 'utf8').trim();
  expect(cwd).toBe(REPO);
});

test('review verdict "rollback" (unstyled) → BLOCKED with reason', () => {
  mockReview('{"decision":"rollback","reason":"Unstyled render (score 0.10): no stylesheets"}', 10);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, process.env, home);
  expect(v.blocked).toBe(true);
  expect(v.blockMessage).toContain('Unstyled render');
});

test('review missing on PATH → fail-open (send proceeds + warn)', () => {
  // ISOLATE the PATH so a real `review` installed on this machine can never be
  // found — otherwise this test silently exercises the wrong binary. We point
  // PATH at ONLY binDir (no `review` there) plus a symlink to the real python3
  // so the hook's `#!/usr/bin/env python3` shebang still resolves.
  const realPython = Bun.which('python3');
  expect(realPython).toBeTruthy();
  // Symlink python3 INTO binDir (its only source on the isolated PATH); we must
  // NOT add python3's real dir to PATH because that same dir usually holds the
  // real `review`. /usr/bin:/bin supply `env` for the shebang.
  symlinkSync(realPython as string, join(binDir, 'python3'));
  const isolatedEnv = { ...process.env, PATH: `${binDir}:/usr/bin:/bin` };
  // Sanity: `review` is genuinely unreachable under this PATH.
  expect(Bun.which('review', { PATH: isolatedEnv.PATH })).toBeNull();

  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, isolatedEnv, home);
  expect(v.blocked).toBe(false);
});

test('review indecisive (human_review) → fail-open allow', () => {
  mockReview('{"decision":"human_review","reason":"vision unavailable"}', 0);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, process.env, home);
  expect(v.blocked).toBe(false);
});

test('review exits 0 with MALFORMED (non-JSON) stdout → fail-open allow (not a clean keep)', () => {
  mockReview('some noisy log line, not json', 0);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, process.env, home);
  expect(v.blocked).toBe(false);
  // proves the review hook ran and treated bad output as indecisive (errored=false
  // at the framework level — the hook itself decided allow, but warned).
  expect(v.results[0].quarantined).toBe(false);
});

test('descriptor present with NO trust pin → RUNS by default (trust-by-default) → blocks', () => {
  mockReview('{"decision":"rollback","reason":"unstyled"}', 10);
  // descriptor only, NO trust pin — trust-by-default means it still runs review.
  const dir = toolHooksDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review-visual.pre-send-photo.json'),
    JSON.stringify({ id: 'review-visual', point: 'pre-send-photo', cmd: PY_HOOK, timeout_ms: 60000 }),
  );
  // This test asserts the GUARD-OFF path; clear any ambient AGENTS_HOOKS_TRUST a
  // dev/CI shell may have exported (keep PATH so the python3 shebang resolves).
  const guardOffEnv = { ...process.env, AGENTS_HOOKS_TRUST: undefined };
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, guardOffEnv, home);
  expect(v.blocked).toBe(true);
  expect(v.results[0].quarantined).toBe(false);
  expect(v.results[0].trustState).toBe('trusted-default');
});

test('AGENTS_HOOKS_TRUST=1 + descriptor with NO trust pin → quarantined, never runs review', () => {
  mockReview('{"decision":"rollback","reason":"unstyled"}', 10);
  const dir = toolHooksDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review-visual.pre-send-photo.json'),
    JSON.stringify({ id: 'review-visual', point: 'pre-send-photo', cmd: PY_HOOK }),
  );
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, { ...process.env, AGENTS_HOOKS_TRUST: '1' }, home);
  expect(v.blocked).toBe(false);
  expect(v.results[0].quarantined).toBe(true);
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { runPreSendPhotoHooks, toolHooksDir, trustFile } from '../features/hooks/run-photo-hooks';
import { invocationDigest } from '../features/hooks/types';

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

// Install a fake `review` that emits a fixed --visual --json verdict + rc.
function mockReview(jsonVerdict: string, exitCode: number): void {
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\n# fake review --visual\ncat <<'JSON'\n${jsonVerdict}\nJSON\nexit ${exitCode}\n`,
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

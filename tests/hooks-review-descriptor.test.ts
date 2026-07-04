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
  // The caption is forwarded as --intent (tg#6188): without it, an intent-gated visual
  // check (e.g. review-cli's selection-highlight module) can never activate for a
  // tg-sent photo — the caption was simply dropped on the floor before this fix.
  // `--intent=<value>` is ONE argv token (not two) so a caption starting with `-`
  // can never be misparsed by argparse as the next option (review found).
  expect(args).toEqual(['visual', pngPath, '--json', '--strict', '--intent=hi']);
  const cwd = readFileSync(cwdFile, 'utf8').trim();
  expect(cwd).toBe(REPO);
});

test('caption is forwarded as --intent, including non-English text', () => {
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: 'элемент выбран' }, process.env, home);
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', pngPath, '--json', '--strict', '--intent=элемент выбран']);
});

test('caption is TRIMMED (not forwarded byte-for-byte) — only outer whitespace is stripped', () => {
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: '  fix applied  ' }, process.env, home);
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', pngPath, '--json', '--strict', '--intent=fix applied']);
});

test('embedded NUL byte in caption is stripped, rest of the text still forwarded', () => {
  // A NUL byte in argv raises ValueError at subprocess.run call time on the Python
  // side — the hook strips it from the caption BEFORE building argv specifically to
  // avoid that crash. Prove the strip happens and the surrounding text survives.
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks(
    { imagePath: pngPath, caption: 'sel' + String.fromCharCode(0) + 'ected' },
    process.env,
    home,
  );
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', pngPath, '--json', '--strict', '--intent=selected']);
});

test('NUL byte in imagePath (not caption) still fails open, via the new ValueError catch', () => {
  // image_path is NOT stripped (unlike caption) — this proves the exact residual path
  // the widened `except (OSError, ValueError)` guards: subprocess.run raises ValueError
  // for an embedded NUL anywhere in argv, and it must resolve to allow (fail-open),
  // matching the OSError branch right next to it and the descriptor's on_error:"open".
  installDescriptorTrusted();
  const badImagePath = pngPath + String.fromCharCode(0) + 'x';
  const v = runPreSendPhotoHooks({ imagePath: badImagePath, caption: 'hi' }, process.env, home);
  expect(v.blocked).toBe(false);
});

test('caption with a lone UTF-16 surrogate drops --intent but review visual STILL RUNS', () => {
  // A lone surrogate (half of a broken UTF-16 pair) raises UnicodeEncodeError when
  // Python's subprocess.run tries to encode it into argv — a ValueError subclass, same
  // as the NUL case. Unlike NUL, this ISN'T stripped by .replace("\x00",""); if it
  // reached subprocess.run unchecked, the exception would be caught by the widened
  // except (OSError, ValueError) around the WHOLE call — meaning `review visual` never
  // runs at all for that photo, not just that --intent is dropped. That would let a
  // crafted caption disable visual verification outright (review found this in an
  // earlier draft). The fix pre-validates encodability and drops ONLY --intent,
  // proven here by asserting `review visual` still executes (argv captured) with no
  // --intent flag, rather than merely asserting `v.blocked === false`.
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const loneSurrogate = String.fromCharCode(0xd800);
  const v = runPreSendPhotoHooks(
    { imagePath: pngPath, caption: `element ${loneSurrogate} selected` },
    process.env,
    home,
  );
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', pngPath, '--json', '--strict']);
});

test('an oversized caption is truncated, not forwarded whole (argv-size defense)', () => {
  // Telegram captions cap at ~1024 chars, but this hook can't rely on that invisible
  // upstream limit (its own comment says so) — a caption large enough to blow past the
  // OS's exec() argv-size limit would raise OSError "Argument list too long" at
  // subprocess.run call time, caught by the widened except, disabling verification for
  // that photo entirely (the same class of bug the NUL/surrogate fixes above close).
  // This doesn't reach the OS limit (that would make the test itself slow/flaky) — it
  // proves the TRUNCATION behavior at the _MAX_INTENT_CHARS boundary instead.
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const overLong = 'x'.repeat(5000);
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: overLong }, process.env, home);
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args[0]).toBe('visual');
  expect(args[3]).toBe('--strict');
  const intentArg = args[4];
  expect(intentArg.startsWith('--intent=')).toBe(true);
  expect(intentArg.length - '--intent='.length).toBeLessThanOrEqual(4096);
});

test('caption that is ONLY NUL bytes strips down to empty — no --intent flag added', () => {
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks(
    { imagePath: pngPath, caption: String.fromCharCode(0, 0) },
    process.env,
    home,
  );
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', pngPath, '--json', '--strict']);
});

test('caption starting with a dash is forwarded as ONE token, never split into a bare option', () => {
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: '--fix applied' }, process.env, home);
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', pngPath, '--json', '--strict', '--intent=--fix applied']);
});

test('caller omits caption entirely → run-photo-hooks defaults it to "", no --intent flag added', () => {
  // buildEvent() in run-photo-hooks.ts defaults a missing caption to '' before it ever
  // reaches the Python hook (args.caption is always a string, never absent) — this
  // proves that default still resolves to "no --intent" end-to-end.
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath }, process.env, home);
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', pngPath, '--json', '--strict']);
});

test('no caption (or blank caption) → no --intent flag added, argv unchanged', () => {
  const argsFile = join(home, 'review-args.txt');
  const review = join(binDir, 'review');
  writeFileSync(
    review,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\ncat <<'JSON'\n{"decision":"keep"}\nJSON\nexit 0\n`,
  );
  chmodSync(review, 0o755);
  installDescriptorTrusted();
  const v = runPreSendPhotoHooks({ imagePath: pngPath, caption: '   ' }, process.env, home);
  expect(v.blocked).toBe(false);
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  expect(args).toEqual(['visual', pngPath, '--json', '--strict']);
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

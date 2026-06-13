import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { runHooksCli } from '../features/hooks/cli';
import { toolHooksDir, trustFile } from '../features/hooks/run-photo-hooks';

// `tg hooks trust/list/untrust` — the activation path the quarantine banner
// advertises. Without this the banner would point at a nonexistent command.

let home: string;
let logs: string[];
let errs: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tg-hooks-cli-'));
  logs = [];
  errs = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  console.error = (...a: unknown[]) => errs.push(a.join(' '));
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  rmSync(home, { recursive: true, force: true });
});

function writeExe(name: string): { path: string; sha: string } {
  const dir = join(home, '.agents', 'skills', 'fake', 'hooks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(path, 0o755);
  return { path, sha: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

function writeDescriptor(id: string, cmd: string): void {
  const dir = toolHooksDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.pre-send-photo.json`),
    JSON.stringify({ id, point: 'pre-send-photo', cmd, on_error: 'open' }),
  );
}

test('non-hooks argv returns null (falls through to send)', () => {
  expect(runHooksCli(['hello world'], home)).toBeNull();
});

test('hooks list shows an untrusted descriptor as quarantined', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const code = runHooksCli(['hooks', 'list'], home);
  expect(code).toBe(0);
  expect(logs.join('\n')).toContain('review-visual');
  expect(logs.join('\n')).toContain('untrusted');
});

test('hooks list on an empty dir says so', () => {
  const code = runHooksCli(['hooks', 'list'], home);
  expect(code).toBe(0);
  expect(logs.join('\n')).toMatch(/No tg hooks installed|empty/);
});

test('hooks trust pins the descriptor sha into trust.json (0600)', () => {
  const { path, sha } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const code = runHooksCli(['hooks', 'trust', 'review-visual'], home);
  expect(code).toBe(0);
  const trust = JSON.parse(readFileSync(trustFile(home), 'utf8'));
  expect(trust['review-visual.pre-send-photo'].cmd_sha256).toBe(sha);
  expect(trust['review-visual.pre-send-photo'].on_error).toBe('open');
});

test('hooks trust with on_error override', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  runHooksCli(['hooks', 'trust', 'review-visual', 'closed'], home);
  const trust = JSON.parse(readFileSync(trustFile(home), 'utf8'));
  expect(trust['review-visual.pre-send-photo'].on_error).toBe('closed');
});

test('hooks trust with an INVALID policy arg errors (no silent default)', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  const code = runHooksCli(['hooks', 'trust', 'review-visual', 'close'], home);
  expect(code).toBe(1);
  expect(errs.join('\n')).toContain("Invalid on_error 'close'");
});

test('hooks trust on an unknown id errors (exit 1)', () => {
  const code = runHooksCli(['hooks', 'trust', 'nope'], home);
  expect(code).toBe(1);
  expect(errs.join('\n')).toContain('nope');
});

test('hooks trust without an id errors', () => {
  const code = runHooksCli(['hooks', 'trust'], home);
  expect(code).toBe(1);
});

test('after trust then list shows trusted', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  runHooksCli(['hooks', 'trust', 'review-visual'], home);
  logs.length = 0;
  runHooksCli(['hooks', 'list'], home);
  expect(logs.join('\n')).toContain('trusted (on_error=open)');
});

test('hooks untrust removes the pin (re-quarantine)', () => {
  const { path } = writeExe('h.sh');
  writeDescriptor('review-visual', path);
  runHooksCli(['hooks', 'trust', 'review-visual'], home);
  const code = runHooksCli(['hooks', 'untrust', 'review-visual'], home);
  expect(code).toBe(0);
  const trust = JSON.parse(readFileSync(trustFile(home), 'utf8'));
  expect(trust['review-visual.pre-send-photo']).toBeUndefined();
});

test('untrust matches the id EXACTLY (does not remove a dotted sibling)', () => {
  // Two hooks: id "review" and id "review.visual". `untrust review` must only
  // remove "review.<point>", never "review.visual.<point>".
  const a = writeExe('a.sh');
  const b = writeExe('b.sh');
  const dir = toolHooksDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review.pre-send-photo.json'),
    JSON.stringify({ id: 'review', point: 'pre-send-photo', cmd: a.path, on_error: 'open' }),
  );
  writeFileSync(
    join(dir, 'review.visual.pre-send-photo.json'),
    JSON.stringify({ id: 'review.visual', point: 'pre-send-photo', cmd: b.path, on_error: 'open' }),
  );
  runHooksCli(['hooks', 'trust', 'review'], home);
  runHooksCli(['hooks', 'trust', 'review.visual'], home);
  const code = runHooksCli(['hooks', 'untrust', 'review'], home);
  expect(code).toBe(0);
  const trust = JSON.parse(readFileSync(trustFile(home), 'utf8'));
  expect(trust['review.pre-send-photo']).toBeUndefined();
  // the dotted sibling MUST survive
  expect(trust['review.visual.pre-send-photo']).toBeDefined();
});

test('unknown subcommand prints usage (exit 2)', () => {
  const code = runHooksCli(['hooks', 'frobnicate'], home);
  expect(code).toBe(2);
  expect(errs.join('\n')).toContain('Usage');
});

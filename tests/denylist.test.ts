import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isNeverAttach } from '../features/auto-attach/denylist';
import { parseArgs } from '../features/cli/args';

// --- pattern matching (basename-based) ---

const BLOCKED = [
  '.env',
  '.env.local',
  '.env.production',
  'prod.env',
  'staging.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'server.pem',
  'private.key',
  'cert.p12',
  'bundle.pfx',
  'app.jks',
  'release.keystore',
  'login.ppk',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.htpasswd',
  '.pgpass',
  '.my.cnf',
  '.bash_history',
  '.zsh_history',
  '.psql_history',
  '.node_repl_history',
  'terraform.tfvars',
  'secrets.auto.tfvars',
  'credentials',
  'credentials.json',
  'client_secret_12345.json',
  'kubeconfig',
  // tg-ctl state: the message history is a full conversation transcript and the
  // routes map leaks pane→project layout — neither must ride a Telegram attach.
  'tg-ctl.123456.history.jsonl',
  'tg-ctl.987.routes.json',
];

const ALLOWED = [
  'environment.ts',
  'envelope.md',
  'env.md',
  'dotenv.ts',
  'id_rsa.pub',
  'turkey.md',
  'monkey.png',
  'keynote.pdf',
  'history.md',
  'npmrc-docs.md',
  'report.json',
  'config.yaml',
  'terraform.tf',
  'credentials-guide.md',
];

test('denylist: secret-looking basenames are blocked', () => {
  for (const name of BLOCKED) {
    expect(isNeverAttach(`/some/dir/${name}`)).toBe(true);
  }
});

test('denylist: ordinary files are not blocked', () => {
  for (const name of ALLOWED) {
    expect(isNeverAttach(`/some/dir/${name}`)).toBe(false);
  }
});

test('denylist: matches the basename, not the directory', () => {
  expect(isNeverAttach('/home/user/.env/readme.md')).toBe(false);
  expect(isNeverAttach('readme.md')).toBe(false);
  expect(isNeverAttach('.env')).toBe(true);
});

// --- parseArgs integration ---

const dir = mkdtempSync(join(tmpdir(), 'tg-denylist-'));
writeFileSync(join(dir, 'prod.env'), 'TOKEN=supersecret\n');
writeFileSync(join(dir, 'normal.ts'), 'export const x = 1\n');

test('explicit --file of a denylisted file is a hard error', () => {
  const r = parseArgs(['--file', join(dir, 'prod.env'), 'oops'], dir, dir);
  expect(r.action).toBe('error');
  if (r.action === 'error') {
    expect(r.message).toContain('prod.env');
    expect(r.message).toContain('--no-feature attach-denylist');
  }
});

test('explicit --photo of a denylisted file is also an error', () => {
  const r = parseArgs(['--photo', join(dir, 'prod.env'), 'oops'], dir, dir);
  expect(r.action).toBe('error');
});

test('auto-detected denylisted file is silently skipped, token stays in text', () => {
  const r = parseArgs([`leaked ${join(dir, 'prod.env')} here`], dir, dir);
  expect(r.action).toBe('send');
  if (r.action === 'send') {
    expect(r.items).toEqual([]);
    expect(r.caption).toContain('prod.env');
  }
});

test('--no-feature attach-denylist override: explicit attach goes through', () => {
  const r = parseArgs(['--file', join(dir, 'prod.env'), 'I know what I am doing'], dir, dir, true, () => [], false);
  expect(r.action).toBe('send');
  if (r.action === 'send') expect(r.items.length).toBe(1);
});

test('denylist does not affect ordinary files (regression)', () => {
  const r = parseArgs([`see ${join(dir, 'normal.ts')}`], dir, dir);
  if (r.action === 'send') expect(r.items.length).toBe(1);
});

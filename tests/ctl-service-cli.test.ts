// End-to-end CLI checks for the tg-ctl service-management lifecycle (the agenttools_service
// contract): bare invocation prints HELP and never launches; the autostart subcommands exist and
// describe a per-OS plan. Like the shared service-management lib's own suite, this NEVER touches
// real autostart — `enable` is exercised through `--dry-run`, which prints the plan (unit path +
// launchctl/systemctl commands) and writes nothing, so no live LaunchAgent / systemd unit is ever
// loaded by the test run. (A real `launchctl load` would register a RunAtLoad agent into the
// tester's session and actually start the daemon — exactly the side effect this avoids.)
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  claudeStatusLineTelemetryInstalled,
  harnessHooksInstalled,
  withClaudeHooks,
  withClaudeStatusLineTelemetry,
} from '../features/tg-ctl/hook-install';

const TG_CTL = join(import.meta.dir, '..', 'tg-ctl');

// Deterministically reap a daemon that `enable`'s fallback spawned (detached). The daemon writes
// its pidfile only AFTER taking the flock, so a bare `stop` races it; poll the pidfile, then
// SIGKILL the pid. Bounded so a never-spawned daemon doesn't hang the test. Leaves nothing behind.
function reapDaemon(cfg: string, botId: string): void {
  const pidFile = join(cfg, `tg-ctl.${botId}.pid`);
  for (let i = 0; i < 50; i++) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      return;
    }
    Bun.sleepSync(50);
  }
}

function run(args: string[], env: Record<string, string>, cwd?: string) {
  return Bun.spawnSync(['bun', TG_CTL, ...args], { cwd, env: { PATH: process.env.PATH ?? '', ...env } });
}

// A throwaway HOME + config dir with fake creds so the bot-token gate passes.
function fakeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'tgctl-svc-'));
  const cfg = mkdtempSync(join(tmpdir(), 'tgctl-cfg-'));
  writeFileSync(join(cfg, '.env'), 'TG_BOT_TOKEN=123456:FAKE\nTG_CHAT_ID=42\n');
  return { home, cfg, env: { HOME: home, TG_CTL_CONFIG_DIR: cfg } as Record<string, string> };
}

// A throwaway bin dir holding a shim binary `name` that always exits with `code`. Prepended to
// PATH so the entrypoint's `launchctl`/`systemctl` spawn hits the shim, never the real OS — lets
// us drive both the success (code 0) and command-FAILURE (code != 0) branches without touching
// real autostart.
function exitCodeShimDir(name: string, code: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'tgctl-shim-'));
  const shim = join(dir, name);
  writeFileSync(shim, `#!/bin/sh\nexit ${code}\n`);
  chmodSync(shim, 0o755);
  return dir;
}

test('bare `tg-ctl` prints HELP on stdout and exits 0 — never launches', () => {
  const proc = run([], { HOME: '/tmp/tg-ctl-svc-nohome' });
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('Usage:');
  expect(out).toContain('tg-ctl enable');
  expect(out).toContain('tg-ctl disable');
  expect(out).toContain('agenttools_service');
  // Help goes to stdout, not stderr (the contract: bare = help, not an error).
  expect(proc.stderr.toString().trim()).toBe('');
});

test('unknown subcommand exits 1 with USAGE on stderr', () => {
  const proc = run(['frobnicate'], { HOME: '/tmp/tg-ctl-svc-nohome' });
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).toContain('Usage:');
});

test.if(process.platform === 'darwin')(
  'enable --dry-run: prints the launchd plan (contract label + plist path + launchctl load) without touching launchd',
  () => {
    const { home, env } = fakeEnv();
    const plist = join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist');

    const enabled = run(['enable', '--dry-run'], env);
    expect(enabled.exitCode).toBe(0);
    const out = enabled.stdout.toString();
    expect(out).toContain('[dry-run]');
    expect(out).toContain('autostart kind: launchd');
    expect(out).toContain('com.agenttools.tg-ctl.tg-ctl');
    expect(out).toContain(plist);
    expect(out).toContain('launchctl load');
    // The whole point of --dry-run: nothing is written and no real agent is loaded.
    expect(existsSync(plist)).toBe(false);
  },
);

test.if(process.platform === 'linux')(
  'enable --dry-run on Linux: prints a systemd-user plan (or the none fallback), writes nothing',
  () => {
    const { home, env } = fakeEnv();

    const enabled = run(['enable', '--dry-run'], env);
    expect(enabled.exitCode).toBe(0);
    const out = enabled.stdout.toString();
    expect(out).toContain('[dry-run]');
    // systemd when `systemctl --user` is available, else the no-op fallback (NOT crontab).
    expect(out).toMatch(/autostart kind: (systemd|none)/);
    expect(out).not.toContain('crontab');
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'agenttools-tg-ctl-tg-ctl.service'))).toBe(false);
  },
);

test('status reports an autostart line (the lifecycle state)', () => {
  const { env } = fakeEnv();
  const proc = run(['status'], env);
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain('autostart:');
});

test('status reports StopFailure hook separately from q→buttons hook', () => {
  const { home, env } = fakeEnv();
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify(withClaudeHooks({}, 'tg-ctl ask').settings)}\n`);

  const proc = run(['status'], env);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('q→buttons hooks: installed');
  expect(out).toContain('limit/error hooks: NOT installed');
  expect(out).toContain('usage telemetry: NOT installed');
});

test('install-hooks provisions Claude statusLine usage telemetry collector', () => {
  const { home, env } = fakeEnv();

  const proc = run(['install-hooks'], env);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('statusLine usage telemetry');

  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  expect(harnessHooksInstalled(settings, 'tg-ctl harness-event')).toBe(true);
  expect(claudeStatusLineTelemetryInstalled(settings, 'tg-ctl harness-event --agent claude')).toBe(true);
});

test('status reports when a project-local Claude statusLine shadows the installed telemetry collector', () => {
  const { home, env } = fakeEnv();
  const installed = run(['install-hooks'], env);
  expect(installed.exitCode).toBe(0);

  const project = mkdtempSync(join(tmpdir(), 'tgctl-proj-'));
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    `${JSON.stringify({ statusLine: { type: 'command', command: 'printf project-only' } })}\n`,
  );

  const proc = run(['status'], env, project);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('usage telemetry: shadowed by');
  expect(out).toContain(join(project, '.claude', 'settings.json'));
  expect(out).not.toContain('usage telemetry: installed (Claude Code statusLine)');

  const userSettings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  expect(claudeStatusLineTelemetryInstalled(userSettings, 'tg-ctl harness-event --agent claude')).toBe(true);
});

test('status checks the registered active scope when invoked from another directory', () => {
  const { cfg, env } = fakeEnv();
  const installed = run(['install-hooks'], env);
  expect(installed.exitCode).toBe(0);

  const project = mkdtempSync(join(tmpdir(), 'tgctl-proj-'));
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    `${JSON.stringify({ statusLine: { type: 'command', command: 'printf project-only' } })}\n`,
  );
  writeFileSync(join(cfg, 'tg-ctl.123456.registration.json'), `${JSON.stringify([{ cwd: project, registeredAt: 2 }])}\n`);

  const shimDir = exitCodeShimDir('tmux', 0);
  const otherDir = mkdtempSync(join(tmpdir(), 'tgctl-other-'));
  const proc = run(['status'], { ...env, PATH: `${shimDir}:${process.env.PATH ?? ''}` }, otherDir);

  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('usage telemetry: shadowed by');
  expect(out).toContain(join(project, '.claude', 'settings.json'));
  expect(out).not.toContain('usage telemetry: installed (Claude Code statusLine)');
});

test('install-hooks from a shadowed project wraps that project-local statusLine override', () => {
  const { home, env } = fakeEnv();
  const installed = run(['install-hooks'], env);
  expect(installed.exitCode).toBe(0);

  const project = mkdtempSync(join(tmpdir(), 'tgctl-proj-'));
  const projectSettingsPath = join(project, '.claude', 'settings.json');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(projectSettingsPath, `${JSON.stringify({ statusLine: { type: 'command', command: 'printf project-only' } })}\n`);

  const proc = run(['install-hooks'], env, project);
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain(`installed Claude statusLine usage telemetry → ${realpathSync(projectSettingsPath)}`);

  const projectSettings = JSON.parse(readFileSync(projectSettingsPath, 'utf8'));
  expect(claudeStatusLineTelemetryInstalled(projectSettings, 'tg-ctl harness-event --agent claude')).toBe(true);

  const status = run(['status'], env, project);
  expect(status.exitCode).toBe(0);
  const out = status.stdout.toString();
  expect(out).toContain('usage telemetry: installed (Claude Code statusLine)');
  expect(out).not.toContain('usage telemetry: shadowed by');

  const userSettings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  expect(harnessHooksInstalled(userSettings, 'tg-ctl harness-event')).toBe(true);
});

test('status stops at the nearest project collector instead of reporting an ancestor shadow', () => {
  const { env } = fakeEnv();
  const installed = run(['install-hooks'], env);
  expect(installed.exitCode).toBe(0);

  const project = mkdtempSync(join(tmpdir(), 'tgctl-proj-'));
  const nested = join(project, 'subdir');
  mkdirSync(join(project, '.claude'), { recursive: true });
  mkdirSync(join(nested, '.claude'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    `${JSON.stringify({ statusLine: { type: 'command', command: 'printf parent-only' } })}\n`,
  );
  const nestedSettings = withClaudeStatusLineTelemetry(
    { statusLine: { type: 'command', command: 'printf nested-collector' } },
    'tg-ctl harness-event --agent claude',
  ).settings;
  writeFileSync(join(nested, '.claude', 'settings.json'), `${JSON.stringify(nestedSettings)}\n`);

  const proc = run(['status'], env, nested);
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain('usage telemetry: installed (Claude Code statusLine)');
  expect(out).not.toContain('usage telemetry: shadowed by');
  expect(out).not.toContain(join(project, '.claude', 'settings.json'));
});

// On a host where the OS control command (launchctl/systemctl) fails, `enable` writes the unit
// but the activation fails — the contract is: fall back to a one-shot start so the service is up
// now, and exit 4 (autostart NOT live). We force failure with a shim that always exits 1, with no
// real launchctl/systemctl reachable (PATH = only the shim dir + bun).
test.if(process.platform === 'darwin')(
  'enable: launchd activation failure → writes plist, falls back to a start, exits 4 (the contract)',
  () => {
    const { home, env } = fakeEnv();
    const shimDir = exitCodeShimDir('launchctl', 1); // launchctl load fails → autostart NOT live
    // bun must still be resolvable for the fallback `start` (it re-spawns this script). Keep the
    // real PATH but PREPEND the shim dir so the failing launchctl wins. Point the API at a dead
    // local port so the fallback daemon's getUpdates fails fast and never hits real Telegram.
    const fullEnv = { ...env, TG_API_BASE: 'http://127.0.0.1:1', PATH: `${shimDir}:${process.env.PATH ?? ''}` };
    const proc = run(['enable'], fullEnv);
    expect(proc.exitCode).toBe(4);
    // The plist was written even though activation failed (so a manual launchctl retry works).
    expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist'))).toBe(true);
    expect(proc.stderr.toString()).toContain('will NOT survive reboot');
    // Reap the fallback daemon the enable spawned (the flock + getUpdates loop), so the test run
    // leaves nothing behind. `cfg` is in `env` (TG_CTL_CONFIG_DIR); botId 123456 from the fake token.
    reapDaemon(env.TG_CTL_CONFIG_DIR, '123456');
  },
);

test.if(process.platform === 'darwin')(
  'disable with no unit installed is a no-op that exits 0 (idempotent removal)',
  () => {
    const { home, env } = fakeEnv();
    // No enable ran, so no plist exists. disable must not error.
    const proc = run(['disable'], env);
    expect(proc.exitCode).toBe(0);
    // Nothing to remove.
    expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist'))).toBe(false);
  },
);

// Full enable→disable round-trip on macOS with a PASSING launchctl shim: enable writes the plist
// and "loads" it (shim exits 0, no real agent), disable "unloads" it and removes the file. This
// pins the idempotent install/remove contract end-to-end without a real LaunchAgent.
test.if(process.platform === 'darwin')(
  'enable then disable (shimmed launchctl): writes the plist then removes it, both exit 0',
  () => {
    const { home, env } = fakeEnv();
    const shimDir = exitCodeShimDir('launchctl', 0); // exit 0 = "succeeded"
    const path = { PATH: `${shimDir}:${process.env.PATH ?? ''}` };
    const plist = join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist');

    const enabled = run(['enable'], { ...env, ...path });
    expect(enabled.exitCode).toBe(0);
    expect(existsSync(plist)).toBe(true);
    expect(enabled.stdout.toString()).toContain('autostart enabled');

    // Re-enable is idempotent: still exit 0, still one file (no duplicate agent).
    const reEnabled = run(['enable'], { ...env, ...path });
    expect(reEnabled.exitCode).toBe(0);
    expect(existsSync(plist)).toBe(true);

    const disabled = run(['disable'], { ...env, ...path });
    expect(disabled.exitCode).toBe(0);
    expect(existsSync(plist)).toBe(false);

    // Disable again is a no-op (idempotent).
    const reDisabled = run(['disable'], { ...env, ...path });
    expect(reDisabled.exitCode).toBe(0);
  },
);

// disable when the OS deactivate (launchctl unload) FAILS: the contract is to LEAVE the unit file
// in place (don't orphan a still-loaded agent by deleting its plist) and exit 4. We first enable
// with a passing shim to put a plist on disk, then disable with a failing one.
test.if(process.platform === 'darwin')(
  'disable: launchctl unload failure → leaves the plist on disk, exits 4 (no orphaning)',
  () => {
    const { home, env } = fakeEnv();
    const plist = join(home, 'Library', 'LaunchAgents', 'com.agenttools.tg-ctl.tg-ctl.plist');

    // Put a plist on disk via an enable with a passing launchctl shim.
    const okShim = { PATH: `${exitCodeShimDir('launchctl', 0)}:${process.env.PATH ?? ''}` };
    expect(run(['enable'], { ...env, ...okShim }).exitCode).toBe(0);
    expect(existsSync(plist)).toBe(true);

    // Now disable with a launchctl that fails the unload.
    const failShim = { PATH: `${exitCodeShimDir('launchctl', 1)}:${process.env.PATH ?? ''}` };
    const disabled = run(['disable'], { ...env, ...failShim });
    expect(disabled.exitCode).toBe(4);
    // The plist is LEFT in place (the OS may still be running the agent).
    expect(existsSync(plist)).toBe(true);
    expect(disabled.stderr.toString()).toContain('leaving the unit file in place');
  },
);

// --- restart (#56) ---

// `restart` must be a known subcommand — not rejected by the unknown-command guard.
// Without creds, it exits 1 for auth, NOT because of the "unknown subcommand" check.
// Distinguisher: unknown exits with USAGE on stderr; missing-creds exits with "TG_BOT_TOKEN".
test('restart: known subcommand — rejected for missing creds, not as unknown', () => {
  const proc = run(['restart'], { HOME: '/tmp/tg-ctl-restart-nocreds' });
  expect(proc.exitCode).toBe(1);
  expect(proc.stderr.toString()).not.toContain('Usage:');
  expect(proc.stderr.toString()).toContain('TG_BOT_TOKEN');
});

// `restart` with a running daemon: stops it, starts a new one, exits 0.
// Uses a dead API base so the daemon loops without external calls. The pidfile
// is our observable: it appears after the grandchild acquires the flock.
test('restart: stops any running daemon and starts a fresh one, exits 0', () => {
  const { env, cfg } = fakeEnv();
  const fullEnv = { ...env, TG_API_BASE: 'http://127.0.0.1:1' };
  // start a daemon first so stopDaemon has something to signal
  const started = run(['start'], fullEnv);
  expect(started.exitCode).toBe(0);
  reapDaemon(cfg, '123456'); // wait for the grandchild to write its pidfile
  const oldPid = Number(readFileSync(join(cfg, 'tg-ctl.123456.pid'), 'utf8').trim());
  expect(oldPid).toBeGreaterThan(0);
  // restart: stops the daemon above, then starts a new one
  const restarted = run(['restart'], fullEnv);
  expect(restarted.exitCode).toBe(0);
  // a new daemon should appear (pidfile may be the same or a new pid — the
  // flock serialises them, so at least one daemon must land a pidfile)
  reapDaemon(cfg, '123456');
}, 10_000);

// --- env-pin (#61) ---

// startLauncher passes TG_CTL_CONFIG_DIR: ctx.configDir to the grandchild even
// when process.env does NOT have TG_CTL_CONFIG_DIR. Verified by running `start`
// with only HOME in env (no TG_CTL_CONFIG_DIR); the grandchild must land its
// pidfile in the HOME-derived configDir, proving it received the right configDir.
test('env-pin: grandchild uses ctx.configDir when TG_CTL_CONFIG_DIR absent from env', () => {
  const home = mkdtempSync(join(tmpdir(), 'tgctl-envpin-'));
  const cfgDir = join(home, '.config', 'tg-cli');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, '.env'), 'TG_BOT_TOKEN=123456:FAKE\nTG_CHAT_ID=42\n');

  // Deliberately omit TG_CTL_CONFIG_DIR — ctx resolves configDir from HOME.
  const envNoConfigDir = {
    HOME: home,
    TG_API_BASE: 'http://127.0.0.1:1',
  };

  const proc = run(['start'], envNoConfigDir as Record<string, string>);
  expect(proc.exitCode).toBe(0);

  // The grandchild must write its pidfile inside cfgDir. If the env pin were
  // absent and the grandchild computed a different configDir, the pidfile would
  // not appear here (reapDaemon times out → test would hang but cleanup kills it).
  reapDaemon(cfgDir, '123456');
});

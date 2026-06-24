// Tests for the pure autostart policy (features/tg-ctl/autostart.ts) — the unit/label/command
// PLANS for `tg-ctl enable` / `disable`. These assert the policy MATCHES the agenttools_service
// contract (PR #54): the `com.agenttools.<tool>.<name>` launchd label, the
// `agenttools-<tool>-<name>.service` systemd unit name, the legacy `launchctl load`/`unload`
// verbs, KeepAlive{SuccessfulExit:false}, Restart=on-failure, and a NO-OP fallback (no crontab)
// when there is no supported OS autostart. Pure — no real launchd/systemd, no I/O.
import { expect, test } from 'bun:test';
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  autostartKind,
  autostartKindLabel,
  autostartStatusLine,
  autostartUnitEnv,
  buildDisablePlan,
  buildEnablePlan,
  defaultConfigDir,
  externalLaunchdSupervisorLabel,
  launchdJobSupervisesBin,
  launchdPlist,
  launchdPlistPath,
  parseLaunchctlListLabels,
  parseLaunchctlPrintArgv,
  systemdUnit,
  systemdUnitPath,
  type AutostartEnv,
  type LaunchdJob,
} from '../features/tg-ctl/autostart';

function env(overrides: Partial<AutostartEnv> = {}): AutostartEnv {
  return {
    platform: 'darwin',
    home: '/home/u',
    binPath: '/home/u/.files/bin/tg-ctl',
    bunPath: '/home/u/.bun/bin/bun',
    logPath: '/home/u/.config/tg-cli/tg-ctl.123456.log',
    // Default config dir → no TG_CTL_CONFIG_DIR pin (the daemon resolves the same path on its own).
    configDir: '/home/u/.config/tg-cli',
    xdgConfigHome: '',
    hasSystemd: false,
    ...overrides,
  };
}

test('labels mirror the agenttools_service contract — com.agenttools.<tool>.<name> / agenttools-<tool>-<name>', () => {
  expect(LAUNCHD_LABEL).toBe('com.agenttools.tg-ctl.tg-ctl');
  expect(SYSTEMD_UNIT).toBe('agenttools-tg-ctl-tg-ctl');
});

test('autostartKind: darwin → launchd, linux+systemd → systemd, otherwise → none (no crontab)', () => {
  expect(autostartKind(env({ platform: 'darwin' }))).toBe('launchd');
  expect(autostartKind(env({ platform: 'linux', hasSystemd: true }))).toBe('systemd');
  expect(autostartKind(env({ platform: 'linux', hasSystemd: false }))).toBe('none');
  expect(autostartKind(env({ platform: 'win32' }))).toBe('none');
});

test('launchd plist: contract label, runs `bun tg-ctl run`, RunAtLoad, KeepAlive{SuccessfulExit:false}, escaped', () => {
  const plist = launchdPlist(env({ binPath: '/u/<bin> & co/tg-ctl' }));
  expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  expect(plist).toContain('<string>run</string>');
  expect(plist).toContain('<key>RunAtLoad</key>\n\t<true/>');
  // KeepAlive is a dict gating on a non-clean exit, NOT a bare <true/> — the mirror of
  // systemd Restart=on-failure.
  expect(plist).toContain('<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>');
  expect(plist).not.toContain('<key>KeepAlive</key>\n\t<true/>');
  // XML-escaped argv values, no raw & or < leaking into the document.
  expect(plist).toContain('/u/&lt;bin&gt; &amp; co/tg-ctl');
  expect(plist).not.toContain('<bin>');
  // Valid plist preamble.
  expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
});

test('launchdPlistPath / systemdUnitPath use the contract names under the right dir', () => {
  expect(launchdPlistPath('/home/u')).toBe(`/home/u/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  expect(systemdUnitPath('/home/u', '')).toBe(`/home/u/.config/systemd/user/${SYSTEMD_UNIT}.service`);
  // $XDG_CONFIG_HOME overrides ~/.config (the lib honors it).
  expect(systemdUnitPath('/home/u', '/xdg/cfg')).toBe(`/xdg/cfg/systemd/user/${SYSTEMD_UNIT}.service`);
});

test('systemd unit: Restart=on-failure + RestartSec=2, network-online ordering, default.target, runs `bun tg-ctl run`', () => {
  const unit = systemdUnit(env({ platform: 'linux', hasSystemd: true }));
  expect(unit).toContain('ExecStart=/home/u/.bun/bin/bun /home/u/.files/bin/tg-ctl run');
  expect(unit).toContain('Restart=on-failure');
  expect(unit).toContain('RestartSec=2');
  expect(unit).not.toContain('Restart=always');
  expect(unit).toContain('Wants=network-online.target');
  expect(unit).toContain('After=network-online.target');
  expect(unit).toContain('WantedBy=default.target');
});

test('systemd ExecStart: a path with spaces is quoted, % is doubled', () => {
  const unit = systemdUnit(env({ platform: 'linux', hasSystemd: true, binPath: '/home/u/my bin/tg-ctl', bunPath: '/o/100%/bun' }));
  expect(unit).toContain('ExecStart=/o/100%%/bun "/home/u/my bin/tg-ctl" run');
});

test('enable plan (launchd): writes plist (0644), legacy unload-then-load, unload optional, manages process', () => {
  const plan = buildEnablePlan(env({ platform: 'darwin' }));
  expect(plan.kind).toBe('launchd');
  expect(plan.managesProcess).toBe(true);
  expect(plan.file?.path).toBe(launchdPlistPath('/home/u'));
  expect(plan.file?.mode).toBe(0o644);
  expect(plan.commands[0].argv).toEqual(['launchctl', 'unload', plan.file!.path]);
  expect(plan.commands[0].optional).toBe(true);
  expect(plan.commands[1].argv).toEqual(['launchctl', 'load', plan.file!.path]);
  expect(plan.commands[1].optional).toBeFalsy();
});

test('enable plan (systemd): writes unit, daemon-reload then enable --now, manages process', () => {
  const plan = buildEnablePlan(env({ platform: 'linux', hasSystemd: true }));
  expect(plan.kind).toBe('systemd');
  expect(plan.managesProcess).toBe(true);
  expect(plan.file?.path).toBe(systemdUnitPath('/home/u', ''));
  expect(plan.commands.map((c) => c.argv.join(' '))).toEqual([
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${SYSTEMD_UNIT}.service`,
  ]);
});

test('enable plan (none fallback): no file, no commands, does NOT manage process (caller background-starts)', () => {
  const plan = buildEnablePlan(env({ platform: 'linux', hasSystemd: false }));
  expect(plan.kind).toBe('none');
  expect(plan.file).toBeUndefined();
  expect(plan.managesProcess).toBe(false);
  expect(plan.commands).toEqual([]);
});

test('disable plan (launchd): removes plist, unload is the gating (non-optional) command', () => {
  const plan = buildDisablePlan(env({ platform: 'darwin' }));
  expect(plan.kind).toBe('launchd');
  expect(plan.filePath).toBe(launchdPlistPath('/home/u'));
  expect(plan.commands[0].argv).toEqual(['launchctl', 'unload', plan.filePath]);
  expect(plan.commands[0].optional).toBeFalsy();
});

test('disable plan (systemd): removes unit, disable --now (gating) then daemon-reload (optional)', () => {
  const plan = buildDisablePlan(env({ platform: 'linux', hasSystemd: true }));
  expect(plan.kind).toBe('systemd');
  expect(plan.filePath).toBe(systemdUnitPath('/home/u', ''));
  expect(plan.commands[0].argv).toEqual(['systemctl', '--user', 'disable', '--now', `${SYSTEMD_UNIT}.service`]);
  expect(plan.commands[0].optional).toBeFalsy();
  expect(plan.commands[1].argv).toEqual(['systemctl', '--user', 'daemon-reload']);
  expect(plan.commands[1].optional).toBe(true);
});

test('disable plan (none fallback): no file, no commands', () => {
  const plan = buildDisablePlan(env({ platform: 'win32' }));
  expect(plan.kind).toBe('none');
  expect(plan.filePath).toBeUndefined();
  expect(plan.commands).toEqual([]);
});

// --- config-dir propagation: a non-default TG_CTL_CONFIG_DIR must survive into the OS unit, or the
// login-launched daemon falls back to ~/.config/tg-cli and can't find the config it was enabled
// with (PR #42 review). The DEFAULT dir is omitted so the unit stays byte-identical to the lib.

test('autostartUnitEnv: default config dir → no env pins; a non-default dir → TG_CTL_CONFIG_DIR', () => {
  expect(autostartUnitEnv(env())).toEqual([]);
  expect(autostartUnitEnv(env({ configDir: defaultConfigDir('/home/u') }))).toEqual([]);
  expect(autostartUnitEnv(env({ configDir: '/custom/cfg' }))).toEqual([['TG_CTL_CONFIG_DIR', '/custom/cfg']]);
});

test('launchd plist: default config dir emits NO EnvironmentVariables block', () => {
  expect(launchdPlist(env())).not.toContain('EnvironmentVariables');
});

test('launchd plist: a non-default config dir pins TG_CTL_CONFIG_DIR in EnvironmentVariables', () => {
  const plist = launchdPlist(env({ configDir: '/custom/cfg' }));
  expect(plist).toContain('<key>EnvironmentVariables</key>');
  expect(plist).toContain('<key>TG_CTL_CONFIG_DIR</key>\n\t\t<string>/custom/cfg</string>');
});

test('launchd plist: a config dir with XML metachars is escaped in the env block', () => {
  const plist = launchdPlist(env({ configDir: '/c/<a> & b' }));
  expect(plist).toContain('<string>/c/&lt;a&gt; &amp; b</string>');
  expect(plist).not.toContain('<a>');
});

test('systemd unit: default config dir emits NO Environment= directive', () => {
  expect(systemdUnit(env({ platform: 'linux', hasSystemd: true }))).not.toContain('Environment=');
});

test('systemd unit: a non-default config dir pins TG_CTL_CONFIG_DIR via Environment=, in [Service]', () => {
  const unit = systemdUnit(env({ platform: 'linux', hasSystemd: true, configDir: '/custom/cfg' }));
  expect(unit).toContain('Environment=TG_CTL_CONFIG_DIR=/custom/cfg');
  // The Environment= line is inside [Service], before ExecStart.
  const svc = unit.indexOf('[Service]');
  const exec = unit.indexOf('ExecStart=');
  const envIdx = unit.indexOf('Environment=');
  expect(svc).toBeGreaterThanOrEqual(0);
  expect(envIdx).toBeGreaterThan(svc);
  expect(envIdx).toBeLessThan(exec);
});

test('systemd unit: a config dir with spaces / % is quoted as one Environment= token', () => {
  const unit = systemdUnit(env({ platform: 'linux', hasSystemd: true, configDir: '/c/my 100% dir' }));
  expect(unit).toContain('Environment="TG_CTL_CONFIG_DIR=/c/my 100%% dir"');
});

// --- external launchd supervision detection (tg-cli#88) -----------------------------------------
// `status` must ALSO recognize an external launchd job (e.g. rig's `ai.hyperide.tg-ctl`) that
// supervises this tg-ctl binary, not only tg-ctl's OWN enable unit — otherwise it lies "NOT enabled"
// while launchd keeps the daemon alive across reboots. These cover the PURE detection policy + the
// parsers for the `launchctl list` / `launchctl print` probe output (the spawn itself lives in the
// entrypoint and isn't unit-tested here).

const BIN = '/home/u/.files/bin/tg-ctl';

test('launchdJobSupervisesBin: matches a job that runs THIS binPath with a `run` subcommand', () => {
  const job: LaunchdJob = { label: 'ai.hyperide.tg-ctl', argv: ['/home/u/.bun/bin/bun', BIN, 'run'] };
  expect(launchdJobSupervisesBin(job, BIN)).toBe(true);
});

test('launchdJobSupervisesBin: false when the job runs a DIFFERENT binary', () => {
  const job: LaunchdJob = { label: 'ai.hyperide.other', argv: ['/home/u/.bun/bin/bun', '/some/other/tool', 'run'] };
  expect(launchdJobSupervisesBin(job, BIN)).toBe(false);
});

test('launchdJobSupervisesBin: false when the job runs this bin but NOT the `run` subcommand', () => {
  // A one-shot `tg-ctl status` job is not autostart supervision of the daemon.
  const job: LaunchdJob = { label: 'ai.hyperide.tg-ctl-once', argv: ['/home/u/.bun/bin/bun', BIN, 'status'] };
  expect(launchdJobSupervisesBin(job, BIN)).toBe(false);
});

test('launchdJobSupervisesBin: false for an empty argv (program unreadable) or empty binPath', () => {
  expect(launchdJobSupervisesBin({ label: 'x', argv: [] }, BIN)).toBe(false);
  expect(launchdJobSupervisesBin({ label: 'x', argv: ['/bun', BIN, 'run'] }, '')).toBe(false);
});

test('externalLaunchdSupervisorLabel: returns the supervising job label when one is present', () => {
  const jobs: LaunchdJob[] = [
    { label: 'com.apple.something', argv: [] },
    { label: 'ai.hyperide.tg-ctl', argv: ['/home/u/.bun/bin/bun', BIN, 'run'] },
  ];
  expect(externalLaunchdSupervisorLabel(jobs, BIN)).toBe('ai.hyperide.tg-ctl');
});

test('externalLaunchdSupervisorLabel: EXCLUDES tg-ctl OWN label (own-mechanism is reported separately)', () => {
  // A job under tg-ctl's own LAUNCHD_LABEL is the `enable` path, handled by the unit-file check —
  // not an "external" supervisor — so it must not be returned here.
  const jobs: LaunchdJob[] = [{ label: LAUNCHD_LABEL, argv: ['/home/u/.bun/bin/bun', BIN, 'run'] }];
  expect(externalLaunchdSupervisorLabel(jobs, BIN)).toBeUndefined();
});

test('externalLaunchdSupervisorLabel: undefined when no loaded job supervises this binary', () => {
  const jobs: LaunchdJob[] = [
    { label: 'com.apple.a', argv: ['/usr/bin/foo'] },
    { label: 'ai.hyperide.model-freshness', argv: ['/home/u/.bun/bin/bun', '/home/u/.files/bin/model-freshness', 'run'] },
  ];
  expect(externalLaunchdSupervisorLabel(jobs, BIN)).toBeUndefined();
});

test('parseLaunchctlListLabels: takes the 3rd tab-field, skips header + short lines', () => {
  const out = ['PID\tStatus\tLabel', '26098\t0\tai.hyperide.tg-ctl', '-\t0\tai.hyperide.tmux-boot', '', 'garbage'].join('\n');
  expect(parseLaunchctlListLabels(out)).toEqual(['ai.hyperide.tg-ctl', 'ai.hyperide.tmux-boot']);
});

test('parseLaunchctlPrintArgv: extracts the ProgramArguments block, trimming each token', () => {
  const out = [
    'gui/501/ai.hyperide.tg-ctl = {',
    '\tstate = running',
    '\targuments = {',
    '\t\t/Users/u/.bun/bin/bun',
    '\t\t/Users/u/.files/bin/tg-ctl',
    '\t\trun',
    '\t}',
    '\tpid = 26098',
    '}',
  ].join('\n');
  expect(parseLaunchctlPrintArgv(out)).toEqual(['/Users/u/.bun/bin/bun', '/Users/u/.files/bin/tg-ctl', 'run']);
});

test('parseLaunchctlPrintArgv: [] when the dump has no arguments block', () => {
  expect(parseLaunchctlPrintArgv('gui/501/x = {\n\tstate = running\n}')).toEqual([]);
});

// Regression guard against the real `launchctl print` shape (captured from a live macOS host): the
// `arguments = { ... }` block holds BARE indented argv tokens, while the surrounding `environment` /
// `default environment` blocks use the `KEY => value` form. The parser must read the bare argv block
// and NOT confuse it with the `=> ` env blocks. If a future macOS changes the arguments-block shape
// this fixture breaks loudly instead of the detection silently regressing to "NOT enabled".
test('parseLaunchctlPrintArgv: real `launchctl print` fixture (bare argv, ignores `=>` env blocks)', () => {
  const fixture = [
    'gui/501/ai.hyperide.tg-ctl = {',
    '\tactive count = 1',
    '\tpath = /Users/u/Library/LaunchAgents/ai.hyperide.tg-ctl.plist',
    '\tstate = running',
    '',
    '\tprogram = /Users/u/.bun/bin/bun',
    '\targuments = {',
    '\t\t/Users/u/.bun/bin/bun',
    '\t\t/Users/u/.files/bin/tg-ctl',
    '\t\trun',
    '\t}',
    '',
    '\tdefault environment = {',
    '\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin',
    '\t}',
    '',
    '\tenvironment = {',
    '\t\tHOME => /Users/u',
    '\t\tXPC_SERVICE_NAME => ai.hyperide.tg-ctl',
    '\t}',
    '\tpid = 26098',
    '}',
  ].join('\n');
  const argv = parseLaunchctlPrintArgv(fixture);
  expect(argv).toEqual(['/Users/u/.bun/bin/bun', '/Users/u/.files/bin/tg-ctl', 'run']);
  // And the captured shape feeds the matcher end-to-end.
  expect(launchdJobSupervisesBin({ label: 'ai.hyperide.tg-ctl', argv }, '/Users/u/.files/bin/tg-ctl')).toBe(true);
});

test('end-to-end (parse → match): a real-shaped launchctl probe detects the external supervisor', () => {
  const realBin = '/Users/u/.files/bin/tg-ctl';
  const listOut = ['PID\tStatus\tLabel', '26098\t0\tai.hyperide.tg-ctl', '-\t0\tai.hyperide.tmux-boot'].join('\n');
  const labels = parseLaunchctlListLabels(listOut);
  const printByLabel: Record<string, string> = {
    'ai.hyperide.tg-ctl': 'x = {\n\targuments = {\n\t\t/Users/u/.bun/bin/bun\n\t\t/Users/u/.files/bin/tg-ctl\n\t\trun\n\t}\n}',
    'ai.hyperide.tmux-boot': 'x = {\n\targuments = {\n\t\t/bin/sh\n\t\t-c\n\t\ttmux start-server\n\t}\n}',
  };
  const jobs: LaunchdJob[] = labels.map((label) => ({ label, argv: parseLaunchctlPrintArgv(printByLabel[label] ?? '') }));
  expect(externalLaunchdSupervisorLabel(jobs, realBin)).toBe('ai.hyperide.tg-ctl');
});

// binPath matching must survive a symlink-vs-target / normalization mismatch — rig may write the
// realpath'd target into ProgramArguments while we resolve the `~/.files/bin/tg-ctl` symlink (or vice
// versa). An exact-string compare would miss the very case this detection exists for, so we ALSO
// match by basename (paired with the `run` requirement so it stays specific).
test('launchdJobSupervisesBin: matches by basename when the job runs a DIFFERENT path to tg-ctl (symlink vs target)', () => {
  // We resolve the symlink path; the job's argv carries the realpath'd target — different strings,
  // same `/tg-ctl` basename.
  const job: LaunchdJob = { label: 'ai.hyperide.tg-ctl', argv: ['/home/u/.bun/bin/bun', '/home/u/dotfiles/bin/tg-ctl', 'run'] };
  expect(launchdJobSupervisesBin(job, '/home/u/.files/bin/tg-ctl')).toBe(true);
});

test('launchdJobSupervisesBin: basename match still requires the `run` subcommand', () => {
  const job: LaunchdJob = { label: 'x', argv: ['/bun', '/home/u/dotfiles/bin/tg-ctl', 'status'] };
  expect(launchdJobSupervisesBin(job, '/home/u/.files/bin/tg-ctl')).toBe(false);
});

// --- autostartStatusLine: pure precedence + formatting (own-unit > external > NOT enabled) -------

test('autostartKindLabel: launchd → own label, systemd → unit name, none → empty', () => {
  expect(autostartKindLabel('launchd')).toBe(LAUNCHD_LABEL);
  expect(autostartKindLabel('systemd')).toBe(`${SYSTEMD_UNIT}.service`);
  expect(autostartKindLabel('none')).toBe('');
});

test('autostartStatusLine (none): not supported on this OS', () => {
  expect(autostartStatusLine('none', false, undefined)).toContain("not supported on this OS");
});

test('autostartStatusLine (own unit installed): reports the precise kind + own label', () => {
  expect(autostartStatusLine('launchd', true, undefined)).toBe(`autostart: enabled (launchd, ${LAUNCHD_LABEL})`);
  expect(autostartStatusLine('systemd', true, undefined)).toBe(`autostart: enabled (systemd, ${SYSTEMD_UNIT}.service)`);
});

test('autostartStatusLine: own unit WINS over an external launchd job (precedence)', () => {
  // Even if an external supervisor is also present, the own-mechanism label is reported.
  expect(autostartStatusLine('launchd', true, 'ai.hyperide.tg-ctl')).toBe(`autostart: enabled (launchd, ${LAUNCHD_LABEL})`);
});

test('autostartStatusLine: external launchd supervisor (own unit absent) → "via launchd: <label>"', () => {
  expect(autostartStatusLine('launchd', false, 'ai.hyperide.tg-ctl')).toBe('autostart: enabled (via launchd: ai.hyperide.tg-ctl)');
});

test('autostartStatusLine: neither mechanism → NOT enabled hint', () => {
  expect(autostartStatusLine('launchd', false, undefined)).toContain('NOT enabled');
  // systemd with no unit and no external supervisor is also NOT enabled (external is launchd-only).
  expect(autostartStatusLine('systemd', false, undefined)).toContain('NOT enabled');
});

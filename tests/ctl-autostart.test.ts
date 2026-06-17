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
  autostartUnitEnv,
  buildDisablePlan,
  buildEnablePlan,
  defaultConfigDir,
  launchdPlist,
  launchdPlistPath,
  systemdUnit,
  systemdUnitPath,
  type AutostartEnv,
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

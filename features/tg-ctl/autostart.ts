// features/tg-ctl/autostart.ts — OS autostart (login/boot self-registration) for the tg-ctl daemon.
//
// What this is: the PURE half of `tg-ctl enable` / `tg-ctl disable`. It computes a per-OS "plan"
// — the unit file to write and the activate/deactivate commands to run — without touching the
// filesystem or spawning anything. The entrypoint (`tg-ctl`) executes the plan; these functions
// only describe it, so the whole policy is unit-testable with no real launchd / systemd and no
// privileged side effects.
//
// Reached at runtime from the `tg-ctl` dispatcher's `enable` / `disable` / `status` cases (see
// enableAutostart / disableAutostart / composeStatus in ../../tg-ctl).
//
// CONTRACT — this mirrors the agent-tools shared service-management lib `agenttools_service`
// (PR #54): the run/start/status/stop/enable/disable lifecycle every long-running server in the
// ecosystem shares. tg-ctl is Bun/TS and cannot import the Python module directly yet, so it
// reproduces the lib's CONTRACT — identical subcommand names, identical launchd LaunchAgent /
// systemd-user SEMANTICS, identical labels and unit-file locations — not its code. Full code-share
// happens when tg-cli grows a Python seam (tracked as a PR follow-up). The choices below are
// deliberately pinned to the lib so the eventual switch is a no-op for users:
//
//   - Label / unit name derive from the lib's `Service.label` / `systemd_unit_name`:
//       launchd  Label      = `com.agenttools.<tool>.<name>`     → com.agenttools.tg-ctl.tg-ctl
//       systemd  unit name  = `agenttools-<tool>-<name>.service` → agenttools-tg-ctl-tg-ctl.service
//   - launchd uses the LEGACY `launchctl load` / `unload` verbs (what the lib pins), NOT the
//     modern `bootstrap` / `bootout gui/<uid>` — the lib defers that migration, so we match it.
//   - launchd KeepAlive is `{SuccessfulExit: false}` (restart ONLY on a non-clean exit), the
//     mirror of systemd `Restart=on-failure` — a bare `KeepAlive=true` would relaunch a daemon
//     that exited 0 in a tight loop.
//   - systemd uses `Restart=on-failure` + `RestartSec=2`, ordered after `network-online.target`,
//     `WantedBy=default.target`, activated with `daemon-reload` then `enable --now`.
//   - NO crontab fallback: on a host with no supported OS autostart (no systemd, or an
//     unsupported OS) the lib's NoopAutostartBackend installs nothing and the manager falls back
//     to a plain background `start`, reporting `enabled=false` so the caller can warn it won't
//     survive reboot. We reproduce exactly that.
//
// ONE deliberate divergence from the lib: tg-ctl has a `TG_CTL_CONFIG_DIR` override the lib does
// not. The OS launches the daemon at login with a minimal environment that does NOT carry the
// shell's $TG_CTL_CONFIG_DIR, so when `enable` ran against a NON-default config dir the unit MUST
// pin it (launchd EnvironmentVariables / systemd Environment=), or the login-launched daemon falls
// back to ~/.config/tg-cli and can't find the credentials it was enabled with. The default dir is
// NOT pinned — the daemon resolves it identically on its own, so the unit stays byte-identical to
// the lib's render (see autostartUnitEnv).
//
// Supported-OS autostart matrix (kept in sync with agent-tools lib/agenttools_service/README.md):
//   macOS             → launchd LaunchAgent (~/Library/LaunchAgents/<label>.plist; RunAtLoad +
//                       KeepAlive{SuccessfulExit:false} → launchd supervises across non-clean exits)
//   Linux + systemd   → systemd --user unit (~/.config/systemd/user/<unit>.service; Restart=on-failure,
//                       `systemctl --user enable --now`, WantedBy=default.target)
//   Linux, no systemd → no-op fallback (background `start`; will NOT survive reboot; enabled=false)
//   Any other OS      → no-op fallback (same; enabled=false)

export const SERVICE_TOOL = 'tg-ctl';
export const SERVICE_NAME = 'tg-ctl';

// launchd reverse-DNS Label — `com.agenttools.<tool>.<name>` (Service.label in the lib).
export const LAUNCHD_LABEL = `com.agenttools.${SERVICE_TOOL}.${SERVICE_NAME}`;
// systemd --user unit name — `agenttools-<tool>-<name>` (Service.systemd_unit_name in the lib).
export const SYSTEMD_UNIT = `agenttools-${SERVICE_TOOL}-${SERVICE_NAME}`;

// 'none' is the lib's NoopAutostartBackend: no OS unit, manager-owned background start instead.
export type AutostartKind = 'launchd' | 'systemd' | 'none';

export interface AutostartEnv {
  platform: NodeJS.Platform;
  home: string;
  // Absolute path to the deployed tg-ctl binary (the ~/.files/bin/tg-ctl symlink in practice).
  // launchd runs the agent with a minimal PATH, so argv[0..1] MUST be absolute (the lib documents
  // the same caveat). The caller resolves this.
  binPath: string;
  // Absolute path to the bun runtime that should launch the daemon (process.execPath).
  bunPath: string;
  // Where launchd/systemd send the daemon's stdout/stderr — the tg-ctl daemon log path.
  logPath: string;
  // The config dir the daemon was enabled with (ctx.configDir). The OS launches the daemon at
  // login with a minimal environment — it does NOT inherit the shell's $TG_CTL_CONFIG_DIR — so
  // when this is a NON-default dir (a `TG_CTL_CONFIG_DIR=/x tg-ctl enable`) the unit must pin it
  // explicitly, or the login-launched daemon would silently fall back to ~/.config/tg-cli and not
  // find the credentials/config it was enabled with. Empty/default ⇒ no env block (the daemon's
  // own default resolves to the same path, so the unit stays byte-identical to the lib's shape).
  configDir: string;
  // $XDG_CONFIG_HOME if set (the lib honors it for the systemd unit dir), else "".
  xdgConfigHome: string;
  // True when `systemctl --user` is usable on this Linux host (probed by the caller); macOS ignores it.
  hasSystemd: boolean;
}

// The default config dir the tg-ctl daemon resolves when $TG_CTL_CONFIG_DIR is unset (mirrors the
// entrypoint's `process.env.TG_CTL_CONFIG_DIR || join(home, ".config", "tg-cli")`). Used to decide
// whether the autostart unit needs to PIN the config dir: only a non-default dir must be pinned.
export function defaultConfigDir(home: string): string {
  return `${home}/.config/tg-cli`;
}

// The environment variables the autostart unit must export so the login-launched daemon uses the
// SAME config dir it was enabled with. Empty when the config dir is the daemon's own default — the
// daemon resolves that path on its own, so pinning it would only bloat the unit (and break unit
// byte-parity with the lib). Returns ordered [name, value] pairs.
export function autostartUnitEnv(env: AutostartEnv): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  if (env.configDir && env.configDir !== defaultConfigDir(env.home)) {
    pairs.push(['TG_CTL_CONFIG_DIR', env.configDir]);
  }
  return pairs;
}

// A single command to spawn, with a human label for plan output. `optional` commands may fail
// without failing the whole plan (e.g. `launchctl unload` when nothing was loaded yet).
export interface AutostartCommand {
  argv: string[];
  describe: string;
  optional?: boolean;
}

// A file the plan writes (enable) — absolute path + exact content + POSIX mode.
export interface AutostartFile {
  path: string;
  content: string;
  mode: number;
}

export interface EnablePlan {
  kind: AutostartKind;
  // The unit file to write (launchd plist / systemd unit). Absent for the 'none' fallback.
  file?: AutostartFile;
  // Whether installing the unit ALSO starts the process now (RunAtLoad / enable --now). When
  // true the OS owns the process and the entrypoint must NOT also background-`start` it — the
  // lib's single-owner / no-double-start invariant. False for 'none' → the entrypoint `start`s.
  managesProcess: boolean;
  // Commands to activate autostart now (load the unit / enable the service), in order. The
  // LAST command is the activating one whose exit code decides `enabled` (the lib gates
  // `enabled` on `launchctl load` / `systemctl enable --now` returning 0).
  commands: AutostartCommand[];
}

export interface DisablePlan {
  kind: AutostartKind;
  // Unit file to remove (if present). Absent for the 'none' fallback.
  filePath?: string;
  // Commands to deactivate autostart (unload / disable), in order. The FIRST is the
  // deactivating one whose success gates removing the file (the lib leaves the file in place
  // and reports failure if unload/disable returned nonzero, to avoid orphaning a live process).
  commands: AutostartCommand[];
}

// Resolve which autostart mechanism this host uses. macOS → launchd; Linux with a working
// `systemctl --user` → systemd; otherwise the no-op fallback (the lib's NoopAutostartBackend).
export function autostartKind(env: AutostartEnv): AutostartKind {
  if (env.platform === 'darwin') return 'launchd';
  if (env.platform === 'linux' && env.hasSystemd) return 'systemd';
  return 'none';
}

// ~/Library/LaunchAgents/com.agenttools.tg-ctl.tg-ctl.plist
export function launchdPlistPath(home: string): string {
  return `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
}

// $XDG_CONFIG_HOME/systemd/user/<unit>.service, falling back to ~/.config (mirrors the lib's
// SystemdUserBackend._unit_dir).
export function systemdUnitPath(home: string, xdgConfigHome: string): string {
  const root = xdgConfigHome ? xdgConfigHome : `${home}/.config`;
  return `${root}/systemd/user/${SYSTEMD_UNIT}.service`;
}

// The OS unit-file path for this host, or undefined on the 'none' fallback (no unit file). A
// cheap pure lookup — does NOT render the plist/unit body (use this, not buildEnablePlan, when you
// only need the path, e.g. an "is it installed?" existence check).
export function autostartUnitPath(env: AutostartEnv): string | undefined {
  const kind = autostartKind(env);
  if (kind === 'launchd') return launchdPlistPath(env.home);
  if (kind === 'systemd') return systemdUnitPath(env.home, env.xdgConfigHome);
  return undefined;
}

// XML-escape a string for safe inlining in plist <string> values (text + attribute safe).
// Order matters: `&` first so we don't double-escape the entities we just produced (mirrors the
// lib's _xml_escape).
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// systemd directive-value escaping. `%` is a specifier introducer in EVERY directive value
// (`%H`→hostname, `%u`→user, …) so a literal `%` MUST be doubled or it is silently substituted —
// even inside ExecStart. The lib's _systemd_quote/_escape_value do the same; control chars are
// rejected upstream (the daemon never feeds user text into these paths, but stay faithful).
function systemdEscapeValue(s: string): string {
  return s.replace(/%/g, '%%');
}

// Quote a single ExecStart token: double `%` first, then wrap in double-quotes if it carries
// whitespace/quotes/backslashes so paths with spaces survive (mirrors the lib's _systemd_quote).
function systemdQuoteToken(token: string): string {
  const escaped = token.replace(/%/g, '%%');
  if (/[\s"\\]/.test(escaped)) {
    return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return escaped;
}

// The launchd LaunchAgent plist. RunAtLoad starts it at load/login; KeepAlive{SuccessfulExit:false}
// restarts it ONLY on a non-clean exit (the mirror of systemd Restart=on-failure) — a bare
// KeepAlive=true would relaunch a daemon that exited 0 in a tight loop. stdout+stderr → the daemon
// log. Byte-for-byte the same shape as the lib's render_launchd_plist (tabs, key order, DOCTYPE).
export function launchdPlist(env: AutostartEnv): string {
  const argv = [env.bunPath, env.binPath, 'run'];
  const args = argv.map((a) => `\t\t<string>${xmlEscape(a)}</string>\n`).join('');
  const log = xmlEscape(env.logPath);
  // EnvironmentVariables pins TG_CTL_CONFIG_DIR for a non-default config dir (launchd starts the
  // agent with a minimal env, so the daemon won't inherit it otherwise). Omitted for the default
  // dir so the plist stays byte-identical to the lib's render_launchd_plist shape.
  const envPairs = autostartUnitEnv(env);
  const envBlock =
    envPairs.length === 0
      ? ''
      : '\t<key>EnvironmentVariables</key>\n' +
        '\t<dict>\n' +
        envPairs
          .map(([k, v]) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t<string>${xmlEscape(v)}</string>\n`)
          .join('') +
        '\t</dict>\n';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '\t<key>Label</key>\n' +
    `\t<string>${xmlEscape(LAUNCHD_LABEL)}</string>\n` +
    '\t<key>ProgramArguments</key>\n' +
    `\t<array>\n${args}\t</array>\n` +
    envBlock +
    '\t<key>RunAtLoad</key>\n' +
    '\t<true/>\n' +
    '\t<key>KeepAlive</key>\n' +
    '\t<dict>\n' +
    '\t\t<key>SuccessfulExit</key>\n' +
    '\t\t<false/>\n' +
    '\t</dict>\n' +
    '\t<key>StandardOutPath</key>\n' +
    `\t<string>${log}</string>\n` +
    '\t<key>StandardErrorPath</key>\n' +
    `\t<string>${log}</string>\n` +
    '</dict>\n' +
    '</plist>\n'
  );
}

// The systemd --user unit. Restart=on-failure (+RestartSec=2) is the Linux equivalent of launchd's
// KeepAlive{SuccessfulExit:false}; WantedBy=default.target makes `enable` wire it into the user's
// login session. Ordered after network-online.target so a login-started daemon doesn't race the
// network. Same shape as the lib's render_systemd_unit.
export function systemdUnit(env: AutostartEnv): string {
  const execStart = [env.bunPath, env.binPath, 'run'].map(systemdQuoteToken).join(' ');
  const desc = systemdEscapeValue(`${SERVICE_TOOL} ${SERVICE_NAME} service`);
  const log = systemdEscapeValue(env.logPath);
  // Environment= pins TG_CTL_CONFIG_DIR for a non-default config dir — systemd --user does NOT
  // export the shell's env into the unit, so the login-launched daemon would otherwise fall back
  // to ~/.config/tg-cli. The whole `KEY=value` is one quoted token (a value with spaces stays one
  // assignment); `%` is doubled like every other directive value. Omitted for the default dir.
  const envBlock = autostartUnitEnv(env)
    .map(([k, v]) => `Environment=${systemdQuoteToken(`${k}=${v}`)}\n`)
    .join('');
  return (
    '[Unit]\n' +
    `Description=${desc}\n` +
    'Wants=network-online.target\n' +
    'After=network-online.target\n' +
    '\n' +
    '[Service]\n' +
    'Type=simple\n' +
    envBlock +
    `ExecStart=${execStart}\n` +
    'Restart=on-failure\n' +
    'RestartSec=2\n' +
    `StandardOutput=append:${log}\n` +
    `StandardError=append:${log}\n` +
    '\n' +
    '[Install]\n' +
    'WantedBy=default.target\n'
  );
}

// Build the enable plan for the host. The caller writes `file` (if any), runs `commands` in order,
// and — when `managesProcess` is false (the 'none' fallback) — background-`start`s the daemon
// itself (the OS won't).
export function buildEnablePlan(env: AutostartEnv): EnablePlan {
  const kind = autostartKind(env);
  if (kind === 'launchd') {
    const path = launchdPlistPath(env.home);
    return {
      kind,
      file: { path, content: launchdPlist(env), mode: 0o644 },
      managesProcess: true,
      commands: [
        // Unload an old copy first so launchctl doesn't refuse the reload (optional — nothing
        // loaded yet is fine); then load the fresh one, which RunAtLoad starts now. The load's
        // exit code decides `enabled`.
        { argv: ['launchctl', 'unload', path], describe: 'unload any existing LaunchAgent', optional: true },
        { argv: ['launchctl', 'load', path], describe: 'load the LaunchAgent (RunAtLoad starts it now)' },
      ],
    };
  }
  if (kind === 'systemd') {
    const path = systemdUnitPath(env.home, env.xdgConfigHome);
    const unit = `${SYSTEMD_UNIT}.service`;
    return {
      kind,
      file: { path, content: systemdUnit(env), mode: 0o644 },
      managesProcess: true,
      commands: [
        { argv: ['systemctl', '--user', 'daemon-reload'], describe: 'reload systemd user units' },
        { argv: ['systemctl', '--user', 'enable', '--now', unit], describe: 'enable + start the user service' },
      ],
    };
  }
  // 'none' fallback: no OS autostart. The entrypoint background-`start`s the daemon instead.
  return { kind, managesProcess: false, commands: [] };
}

// Build the disable plan: deactivate autostart and remove the managed unit. The caller runs the
// FIRST command (the deactivator) and only removes the file if it succeeded — leaving a still-
// loaded unit's file in place rather than orphaning the live process (the lib's uninstall rule).
export function buildDisablePlan(env: AutostartEnv): DisablePlan {
  const kind = autostartKind(env);
  if (kind === 'launchd') {
    const path = launchdPlistPath(env.home);
    return {
      kind,
      filePath: path,
      // `launchctl unload` stops the running job AND removes it from launchd, so no separate stop
      // is needed on macOS. Its success gates the file removal.
      commands: [{ argv: ['launchctl', 'unload', path], describe: 'unload the LaunchAgent (stops it)' }],
    };
  }
  if (kind === 'systemd') {
    const path = systemdUnitPath(env.home, env.xdgConfigHome);
    const unit = `${SYSTEMD_UNIT}.service`;
    return {
      kind,
      filePath: path,
      // `disable --now` stops the running unit AND removes the login wiring; daemon-reload after.
      commands: [
        { argv: ['systemctl', '--user', 'disable', '--now', unit], describe: 'disable + stop the user service' },
        { argv: ['systemctl', '--user', 'daemon-reload'], describe: 'reload systemd user units', optional: true },
      ],
    };
  }
  // 'none' fallback: nothing was installed. The entrypoint just stops the background daemon.
  return { kind, commands: [] };
}

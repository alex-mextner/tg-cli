// Never-attach denylist: files that must NOT leave the machine via Telegram,
// whatever the user typed. Secrets-focused and basename-based — matching the
// directory would block innocent files living next to a secret.
//
// Semantics (wired in tg's parseArgs, feature `attach-denylist`, ON by
// default):
//   - auto-detected path in the text  → silently skipped, token stays in text
//     (same posture as the extensionless gate);
//   - explicit --photo/--file        → HARD ERROR before anything is sent —
//     an explicit secret attach is almost certainly a mistake or a leak, and
//     a silent skip would hide it.
// Override (consciously): --no-feature attach-denylist or
// features.attach-denylist: false in ~/.config/tg-cli/config.yaml.

export const NEVER_ATTACH_PATTERNS: RegExp[] = [
  // dotenv family: .env, .env.local, .env.production, prod.env, staging.env
  /^\.env(\..+)?$/i,
  /\.env$/i,
  // SSH private keys (id_rsa.pub stays allowed — it is public by definition)
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  // key material / certificate stores
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  // credential rc-files
  /^\.(netrc|npmrc|pypirc|git-credentials|htpasswd|pgpass|my\.cnf)$/,
  // shell / REPL histories (often contain pasted tokens)
  /^\..*_history$/,
  // terraform variable files (the canonical place for secrets)
  /\.tfvars$/i,
  // cloud credentials: gcloud/OAuth client secrets, generic credentials file
  /^credentials(\.json)?$/i,
  /^client_secret.*\.json$/i,
  // kubernetes access config
  /^kubeconfig$/i,
  // tg-ctl daemon state: the message history is a full conversation transcript
  // (`tg replies` source) and the routes map leaks pane→project layout. Neither
  // should ever ride a Telegram attach, even when named explicitly.
  /^tg-ctl\..*\.history\.jsonl$/i,
  /^tg-ctl\..*\.routes\.json$/i,
];

/** True when the file's BASENAME matches any never-attach pattern. */
export function isNeverAttach(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (!base) return false;
  return NEVER_ATTACH_PATTERNS.some((re) => re.test(base));
}

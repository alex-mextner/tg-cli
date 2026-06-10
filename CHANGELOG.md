# Changelog

All notable changes to `tg` are documented here. This project adheres to
semantic versioning.

## 1.3.0

Never-attach denylist (`attach-denylist` feature, ON by default):

- Secret-looking files are never attached: the `.env` family, SSH private
  keys (`id_rsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`), credential
  rc-files (`.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`,
  `.my.cnf`, `.htpasswd`), shell/REPL histories, `*.tfvars`,
  `credentials.json` / `client_secret*.json`, `kubeconfig`.
- Auto-detected mentions in the text are silently skipped (the token stays);
  an explicit `--photo`/`--file` of a denylisted file is a hard ERROR before
  anything is sent.
- Conscious override: `--no-feature attach-denylist` or
  `features.attach-denylist: false` in `~/.config/tg-cli/config.yaml`.

## 1.2.0

Attachment quality pass:

- Markdown as PDF (`md-as-pdf` feature, ON by default): attached `.md` files
  are converted to PDF via pandoc + headless Chrome — emoji and Cyrillic
  render correctly. Any conversion failure attaches the original `.md`.
- UTF-8 BOM for text attachments: documents with non-ASCII UTF-8 content get
  a BOM prepended to the uploaded copy (disk file untouched), fixing
  Telegram's preview mojibake for Cyrillic. Scripts (`.sh`) and `.json` are
  deliberately excluded.
- Extensionless files (LICENSE, Makefile, `.env`) are no longer auto-attached;
  explicit `--photo`/`--file` still attach anything.
- Linear response cache: autolink-tasks verdicts (including verified-absent)
  are cached for 1 hour in `~/.cache/tg-cli/linear-cache.json` — repeated
  reports about the same tickets no longer spawn the `linear` CLI each send.

## 1.1.0

Autolink tasks (`autolink-tasks` feature, ON by default):

- Ticket-like codes in the message text (3 uppercase letters + dash + digits,
  e.g. `HYP-576`) are verified against Linear via the `linear` CLI and turned
  into links.
- A single mentioned ticket gets its title on the first line (after the
  emoji/[window] prefix when present); several tickets get a collapsed
  `<blockquote expandable>` reference block (`code: title`) at the end.
- Codes Linear doesn't know stay plain text. A missing `linear` CLI or missing
  auth produces a one-time stderr hint; the message is always sent unchanged
  on any autolink failure.
- Toggle with `--no-feature autolink-tasks` or
  `features.autolink-tasks: false` in `~/.config/tg-cli/config.yaml`.

## 1.0.0

CLI ergonomics pass:

- `-v` / `--version`: print version, the running git commit hash, and this
  changelog, then exit 0.
- Help anywhere: `-h`/`--help` (or no arguments at all) prints usage to stdout
  and exits 0 instead of sending an empty message.
- Auto-attach paths: existing file paths found in the message text are attached
  automatically (images as photos, everything else as documents) and excised
  from the caption.
- `OK` on success: a successful send prints `OK` to stdout.
- Unknown dashed flags are an error: a stray `--foo` prints help to stderr and
  exits non-zero instead of being sent as message text. All real flags
  (`--format`, `--photo`, `--file`, `--ls-emoji-helpers`, `--detect-model`) are
  still recognized — the unknown-flag check runs only after they are matched.

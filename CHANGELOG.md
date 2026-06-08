# Changelog

All notable changes to `tg` are documented here. This project adheres to
semantic versioning.

## 1.0.0

CLI ergonomics pass:

- `-v` / `--version`: print version, the running git commit hash, and this
  changelog, then exit 0.
- Help on empty invocation: running `tg` with no arguments prints usage and
  exits 0 instead of sending an empty message.
- Auto-attach paths: existing file paths found in the message text are
  attached automatically (images as photos, everything else as documents) and
  excised from the caption.
- `OK` on success: a successful send prints `OK` to stdout.
- Unknown dashed flags are an error: a stray `--foo` prints help to stderr and
  exits non-zero instead of being sent as message text.

# tg-cli — md-as-pdf feature spec

Module: `features/md-pdf/convert.ts`. ON by default. Toggle: `--no-feature md-as-pdf` or
`features: { md-as-pdf: false }` in `~/.config/tg-cli/config.yaml`.

## North star

`.md` / `.markdown` files attached from disk are converted to PDF before upload. Telegram's
native Markdown preview is unreliable for rich documents (tables, fenced code, formatting);
a PDF renders correctly on every client and is immediately readable without a viewer app. The
conversion is silent on success and non-blocking on failure. Local images referenced by the
markdown are deliberately NOT embedded into the PDF — see [Security](#security).

## Pipeline

1. Detect: attachment is a disk-sourced `.md` or `.markdown` file (auto-detected path or
   explicit `--file`).
2. **Pandoc pass** — convert to self-contained HTML5:
   ```
   pandoc --from=gfm --to=html5 --standalone <input.md> -o <tmp.html>
   ```
3. **Chrome print pass** — render HTML to PDF:
   ```
   <chrome> --headless=new --no-pdf-header-footer \
            --host-resolver-rules="MAP * ~NOTFOUND" \
            --virtual-time-budget=2000 \
            --print-to-pdf=<tmp.pdf> \
            "file://<percent-encoded-absolute-path-to-tmp.html>"
   ```
   The print runs through the shared `printToPdf` helper, the single source of the
   Chrome print flags for both this path and the code-as-pdf / html-report paths
   (`features/code-pdf/convert.ts`), so they cannot drift on the print sandbox. See
   [Security](#security).
4. Upload the resulting PDF in place of the original `.md`. The filename shown in Telegram
   is `<original-basename>.pdf`.
5. On any failure (see below) — upload the original `.md` unchanged and emit a one-line
   warning to stderr. The send is never blocked.

### file:// URL encoding requirement

The path passed to Chrome must be a valid `file://` URL. Non-ASCII characters in the
absolute path (e.g. Cyrillic or CJK directory names) must be percent-encoded
(`encodeURIComponent` per path segment, `/` separators preserved). Passing a raw path with
non-ASCII bytes causes Chrome to silently produce a blank PDF.

### Chrome binary discovery

Checked in order:
1. `TG_CHROME_PATH` environment variable (absolute path).
2. `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on `PATH`.
3. macOS default locations: `/Applications/Google Chrome.app/…/MacOS/Google Chrome`,
   `/Applications/Chromium.app/…/MacOS/Chromium`.

If no binary is found, the feature degrades to uploading the original `.md`.

## Scope: disk-only; memory-sourced markdown excluded

The conversion applies **only** to disk files (R1 / explicit `--file`). It does NOT apply
to:
- **R4 fragment files** (large inline code blocks extracted from the message text into
  in-memory blobs). These fragments are not standalone documents; converting them to PDF
  would wrap a raw code excerpt in a document shell and hide any marker comments injected
  for line-spec navigation.
- **Line-spec marker copies** (in-memory copies of source files with injected marker-comment
  bands). Same reason: the marker comments are meaningful only as plain text; they would be
  invisible or misleading in PDF form.
- Any `{filename, content}` in-memory `SendItem`, regardless of extension.

The distinction is: if the original source is a real file the user deliberately referenced
or attached, convert it. If the content was assembled in memory by tg-cli itself, do not.

## Failure policy

Any of the following causes a silent fallback (original `.md` uploaded, stderr warning):
- `pandoc` not found or exits non-zero.
- Chrome binary not found or exits non-zero.
- Output PDF is absent or zero bytes after Chrome exits.
- Any unhandled exception during the pipeline.

The warning line format: `[md-as-pdf] <reason>: falling back to .md upload`.

Temp files (`<tmp>.html`, `<tmp>.pdf`) are created in the OS temp directory and deleted in
a `finally` block regardless of success or failure. On unclean exit (process kill), the OS
cleans them up on the next reboot in the normal course.

## Security

The PDF is rendered from user-supplied markdown and then uploaded to Telegram, so the
render must not be a network-egress or local-file-disclosure channel (issue tg-cli#102 —
parity with the `.html` report path, tg-cli#95/#96):

- **Network blackhole.** The Chrome print runs with
  `--host-resolver-rules="MAP * ~NOTFOUND"`, which fails every DNS lookup. A markdown
  document with a remote resource (`![x](http://host/p.png)`, a remote font/iframe) cannot
  resolve a host at print time, so it cannot beacon out (tracking pixel / SSRF / egress).
  Scope: this blocks remote HOST NAMES; an IP-literal host may skip the resolver and a
  `file://` subresource needs no DNS — but there is no return channel either way.
- **No pandoc-stage local-file inlining.** pandoc is invoked WITHOUT `--embed-resources` /
  `--resource-path`. `--embed-resources` base64-inlines any local file the markdown
  references (`![x](/etc/passwd)`, `![x](../secret)`) into the HTML it produces — with zero
  attacker effort, for EVERY referenced path, relative or absolute — and fetches remote
  `src=`s at the pandoc stage. Dropping it closes both. The cost: a relative LOCAL image in
  the markdown shows broken in the PDF (remote images are blackholed regardless). A report
  is text-formatting, not an image document.

This closes the two surfaces above but is **not full parity** with the `.html` report path.
Two residuals remain, both tracked:

- **tg-cli#103 (shared with the `.html` path):** removing `--embed-resources` stops the
  pandoc-stage inlining, but Chrome itself — printing the `file://` document — still loads
  an ABSOLUTE-path or `file:`-scheme subresource (`<img src="file:///abs/secret.png">`) and
  prints it into the PDF; the DNS blackhole does not apply to `file://`. A relative ref is
  safe (it resolves into the temp dir, where the file isn't).
- **tg-cli#104 (md path only):** unlike the `.html` path — which runs `sanitizeReportHtml`
  + `stripEventHandlerAttrs` to strip `<script>`/`<iframe>`/`<object>`/`<embed>`/`<svg>` and
  `on*=` handlers before the print — `convertMdToPdf` does NOT sanitize pandoc's output.
  pandoc keeps gfm `raw_html` on, so a hostile `.md` with a raw `<iframe src="file://…">`
  (arbitrary local TEXT disclosure, broader than the `<img>` residual) or `<script>` reaches
  Chrome. Bringing the md path to the `.html` path's sanitization is tracked as tg-cli#104.

Both the md-pdf path and the code-pdf/html-report paths share one print helper
(`printToPdf` in `features/md-pdf/convert.ts`), so the print sandbox flags are defined in a
single place and the paths cannot silently diverge.

## Dependencies

- **pandoc** — must be on `PATH`. Install: `brew install pandoc` (macOS) /
  `apt install pandoc` (Debian/Ubuntu). No version constraint beyond GFM support
  (available since pandoc 2.x).
- **Headless Chrome** — Chromium or Google Chrome, version 112+ (when `--headless=new` was
  stabilised). Discovered automatically; override with `TG_CHROME_PATH`.
- **Emoji + Cyrillic rendering** — relies on the system font stack. No special font
  installation required on macOS or a standard Linux desktop. Headless server environments
  without font packages may need `fonts-noto` or similar.

## Non-goals

- No LaTeX / XeLaTeX pipeline. Pandoc's `--pdf-engine=xelatex` is not used — too heavy a
  dependency for a CLI tool.
- No multi-page layout tuning (margins, page size, CSS print media). Default Chrome print
  output is acceptable.
- No conversion of in-memory fragment blobs or marker copies (see Scope section).
- No re-encoding or compression of the output PDF.
- No conversion of formats other than `.md` / `.markdown`.

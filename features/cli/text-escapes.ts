// Decodes tg's supported literal escape sequences (`\n`, `\r`, `\t`, `\\`) in a caption
// typed as ONE shell argument — the convention documented for `tg`'s own callers, since a
// real newline inside a single-quoted argv token is awkward to type/pass through some
// callers. Shared between the CLI entrypoint (`tg`, which decodes the final caption right
// before send) and the parse-time escalation-format gate (`features/cli/args.ts`), which
// must validate the DECODED content — validating the raw, still-escaped caption sees a
// compliant multiline decision-request body as one long pipe-containing line and false-
// positive-blocks it (review finding, tg-cli#202).
export function decodeTextEscapes(value: string): string {
  return value.replace(/\\([nrt\\])/g, (_match: string, escaped: string) => {
    if (escaped === "n") return "\n"
    if (escaped === "r") return "\r"
    if (escaped === "t") return "\t"
    return "\\"
  })
}

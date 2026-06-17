// --- Regex utilities (pure) ---
//
// escapeRegExp turns an arbitrary string into a literal that is safe to splice
// into a `new RegExp(...)` source. It escapes the FULL set of ECMAScript regex
// metacharacters — not just one or two — so building a pattern from external or
// structured tokens can never let a stray `.`, `\`, `(`, `[`, etc. change the
// pattern's meaning. A partial escaper (e.g. one that handles `-` but leaves
// `\` untouched) is what CodeQL flags as js/incomplete-sanitization; this is the
// single, complete source of truth both render/rich and install-skill use.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

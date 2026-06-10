// Upload-encoding fix for text attachments.
//
// tg always uploads file bytes VERBATIM — attachments are valid UTF-8 if the
// source file is. The mojibake users see is Telegram's built-in text preview:
// without a BOM it sniffs the encoding and routinely guesses a legacy codepage
// for Cyrillic UTF-8. Prepending a UTF-8 BOM (EF BB BF) to the uploaded COPY
// pins the preview to UTF-8. The original file on disk is never touched.
//
// The BOM is added only when ALL of these hold:
//   - the filename has a known text extension (whitelist below; sh/json are
//     deliberately absent — a BOM breaks shebangs and JSON.parse),
//   - the content is valid UTF-8 (strict decode) with at least one non-ASCII
//     byte (pure-ASCII previews can't mojibake),
//   - there is no BOM already,
//   - the file is not huge (cap below — buffering a giant log to maybe add
//     3 bytes is not worth it).

export const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
export const BOM_MAX_BYTES = 2 * 1024 * 1024;

const BOM_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'rst', 'org', 'adoc',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp',
  'sql', 'html', 'htm', 'xml', 'css', 'scss', 'less', 'vue', 'svelte',
  'diff', 'patch', 'tex',
]);

function extOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the bytes to UPLOAD for a document: BOM-prefixed copy when the file
 * is non-ASCII UTF-8 text Telegram's preview would garble, otherwise the
 * original bytes untouched.
 */
export function maybeAddBom(bytes: Uint8Array, filename: string): Uint8Array {
  if (bytes.length === 0 || bytes.length > BOM_MAX_BYTES) return bytes;
  if (!BOM_TEXT_EXTENSIONS.has(extOf(filename))) return bytes;
  if (hasBom(bytes)) return bytes;
  let hasNonAscii = false;
  for (const b of bytes) {
    if (b === 0) return bytes; // NUL → not text, whatever the extension says
    if (b >= 0x80) hasNonAscii = true;
  }
  if (!hasNonAscii) return bytes;
  if (!isValidUtf8(bytes)) return bytes;
  const out = new Uint8Array(UTF8_BOM.length + bytes.length);
  out.set(UTF8_BOM, 0);
  out.set(bytes, UTF8_BOM.length);
  return out;
}

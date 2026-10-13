/**
 * Checksum list parsing (`SHA2-256SUMS`, `SHA256SUMS`, `*.sha256sum`).
 * Accepts the coreutils format (`<hex>  <name>` or `<hex> *<name>`) and is
 * lenient about CRLF and blank lines.
 */

const LINE = /^([A-Fa-f0-9]{64})\s+\*?(.+?)\s*$/;

/** Map file name → lower-case SHA-256. */
export function parseChecksumList(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const match = LINE.exec(raw.trim());
    if (!match?.[1] || !match[2]) continue;
    const name = match[2].replace(/^\.\//, '');
    out.set(name, match[1].toLowerCase());
  }
  return out;
}

export function checksumFor(text: string, fileName: string): string | null {
  return parseChecksumList(text).get(fileName) ?? null;
}

/** Constant-shape comparison of two hex digests (case-insensitive). */
export function sameDigest(expected: string, actual: string): boolean {
  const a = expected.toLowerCase();
  const b = actual.toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

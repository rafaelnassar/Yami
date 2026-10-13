/**
 * Normalizes one raw line of engine output before it is interpreted:
 * strips terminal escape sequences, resolves carriage-return redraws, trims and
 * applies Unicode NFC (macOS/HFS+ and some extractors emit NFD file names).
 */

/**
 * CSI sequences (`ESC [ … final`), OSC sequences (`ESC ] … BEL|ST`) and 2-byte
 * `ESC x` escapes. Broader than SGR-only (`ESC[…m`) on purpose (spec 03 Q28).
 */
// eslint-disable-next-line no-control-regex -- matching ESC/BEL terminal escapes is the point
const ANSI_ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPES, '');
}

/**
 * Returns the visible content of a raw line (`''` when there is none).
 * A progress bar written without `--newline` arrives as CR-separated redraws in a
 * single line: the last non-empty segment is what a terminal would display.
 */
export function normalizeEngineLine(raw: string): string {
  const segments = stripAnsi(raw).split('\r');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = (segments[index] ?? '').trim();
    if (segment) return segment.normalize('NFC');
  }
  return '';
}

/** Removes one pair of matching wrapping quotes (`"…"` or `'…'`) and trims. */
export function stripWrappingQuotes(value: string): string {
  const text = value.trim();
  if (text.length < 2) return text;
  const first = text[0];
  if ((first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1).trim();
  return text;
}

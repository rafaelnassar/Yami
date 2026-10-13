/** Normalizes the progress fields engines print (percent, speed, ETA). */

/** Parses `" 42.5%"`, `"42.5"`; `null` for `N/A`, `NA`, `Unknown`… Clamped to 0–100. */
export function parsePercent(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseFloat(raw.replace('%', '').trim());
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/** Keeps a printed speed (`1.20MiB/s`); `null` when the engine does not know it. */
export function normalizeSpeed(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  if (!value || /^(?:unknown|n\/?a|none)\b/i.test(value)) return null;
  return value;
}

/** Keeps a clock-style ETA (`00:08`, `1:02:03`); `null` otherwise. */
export function normalizeEta(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  return /^\d+(?::\d+)+$/.test(value) ? value : null;
}

const SPEED = /\s+at\s+(\S+)/;
const ETA = /\bETA\s+(\d+:\d+:\d+|\d+:\d+)\b/i;

/** Speed and ETA from a default `[download]  42.5% of 12MiB at 1.2MiB/s ETA 00:08` line. */
export function speedAndEtaOf(line: string): { readonly speed: string | null; readonly eta: string | null } {
  return { speed: normalizeSpeed(SPEED.exec(line)?.[1]), eta: normalizeEta(ETA.exec(line)?.[1]) };
}

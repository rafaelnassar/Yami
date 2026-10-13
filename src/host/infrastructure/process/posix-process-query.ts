/**
 * POSIX process queries (pure parsers):
 * - Linux: `/proc/<pid>/stat` (field 22 `starttime`, clock ticks since boot) and `/proc/<pid>/comm`.
 * - macOS: `ps -o pid=,lstart=,comm= -p <pids>` (no /proc). `pid=` is added so a
 *   batched query can be mapped back to its PIDs.
 */

export interface ProcStat {
  /** Field 3 (`R`, `S`, `Z`…). */
  readonly state: string;
  /** Field 22, clock ticks after boot. */
  readonly startTime: string;
}

/**
 * Parses `/proc/<pid>/stat`. The command name (field 2) may contain spaces and
 * parentheses, so fields are counted after the LAST `)`.
 */
export function parseProcStat(content: string): ProcStat | null {
  const close = content.lastIndexOf(')');
  if (close < 0) return null;
  const rest = content
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (state); field 22 is rest[19].
  const state = rest[0];
  const startTime = rest[19];
  if (!state || !startTime || !/^\d+$/.test(startTime)) return null;
  return { state, startTime };
}

/** Zombie/dead entries are processes that already exited (just not reaped yet). */
export function isExitedState(state: string): boolean {
  return state === 'Z' || state === 'X' || state === 'x';
}

export function psArgs(pids: readonly number[]): string[] {
  return ['-o', 'pid=,lstart=,comm=', '-p', pids.map((pid) => String(Math.trunc(pid))).join(',')];
}

export interface PsRow {
  readonly pid: number;
  /** `lstart` with whitespace collapsed (1 s resolution, stable for the process lifetime). */
  readonly startToken: string;
  /** macOS `comm` is the executable path. */
  readonly command: string;
}

// pid, then lstart = 5 tokens ("Tue Sep 30 10:12:33 2026"), then comm (may contain spaces).
const PS_LINE = /^\s*(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

export function parsePsOutput(stdout: string): Map<number, PsRow> {
  const out = new Map<number, PsRow>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const [, pidText, lstart, command] = match;
    if (!pidText || !lstart || !command) continue;
    const pid = Number(pidText);
    out.set(pid, { pid, startToken: lstart.replace(/\s+/g, ' '), command });
  }
  return out;
}

/** Basename for both separators, lower-cased (`/usr/local/bin/yt-dlp` → `yt-dlp`). */
export function imageNameOf(executablePath: string): string | null {
  const trimmed = executablePath.trim().replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = (index >= 0 ? trimmed.slice(index + 1) : trimmed).toLowerCase();
  return base || null;
}

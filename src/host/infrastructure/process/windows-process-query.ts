/**
 * Windows process queries (pure builders/parsers; execution goes through
 * `CommandRunner`). One backend only: PowerShell `Get-CimInstance Win32_Process`
 * (wmic was removed in recent Windows builds). `tasklist` is a cheap liveness
 * fallback that yields image names but no start token.
 */
import { v } from '../../../shared/validation/schema.ts';
import type { ProcessSnapshot } from './process-snapshot.ts';

export interface WindowsSystemPaths {
  readonly powershell: string;
  readonly tasklist: string;
  readonly taskkill: string;
}

/** Absolute System32 paths so a planted `tasklist.exe` in the cwd/PATH is never picked up. */
export function windowsSystemPaths(systemRoot: string): WindowsSystemPaths {
  const root = systemRoot.replace(/[\\/]+$/, '');
  return {
    powershell: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    tasklist: `${root}\\System32\\tasklist.exe`,
    taskkill: `${root}\\System32\\taskkill.exe`
  };
}

/**
 * PowerShell arguments for a batched Win32_Process query. Only integer PIDs are
 * interpolated and the script uses single quotes only, so Windows argv quoting
 * can never change its meaning. Output: a compact JSON array.
 */
export function powershellQueryArgs(pids: readonly number[]): string[] {
  const filter = pids.map((pid) => `ProcessId=${Math.trunc(pid)}`).join(' OR ');
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `$r=@(Get-CimInstance -ClassName Win32_Process -Filter '${filter}' | ForEach-Object {` +
      '$c=$_.CreationDate; [pscustomobject]@{ProcessId=[int]$_.ProcessId;Name=$_.Name;' +
      "CreationDate=$(if($c){$c.ToUniversalTime().ToString('o')}else{$null});ExecutablePath=$_.ExecutablePath}})",
    'ConvertTo-Json -InputObject $r -Compress -Depth 2'
  ].join('; ');
  return ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script];
}

const CimProcessSchema = v.object(
  {
    ProcessId: v.number({ int: true, min: 0 }),
    Name: v.optional(v.nullable(v.string({ max: 1024 }))),
    CreationDate: v.optional(v.nullable(v.string({ max: 128 }))),
    ExecutablePath: v.optional(v.nullable(v.string({ max: 32_767 })))
  },
  { strict: false }
);

/**
 * Parses the PowerShell output. Returns `null` when the output is not the
 * expected JSON (treated by the caller as "query failed").
 */
export function parsePowershellProcesses(stdout: string): ProcessSnapshot[] | null {
  const text = stdout.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // PowerShell 5.1 may still unwrap a single-element array into an object.
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProcessSnapshot[] = [];
  for (const item of items) {
    const row = CimProcessSchema.parse(item);
    if (!row.ok) return null;
    const { ProcessId, Name, CreationDate, ExecutablePath } = row.value;
    const startToken = CreationDate ? normalizeCreationDate(CreationDate) : null;
    out.push({
      pid: ProcessId,
      imageName: Name ? Name.toLowerCase() : null,
      startToken,
      startTokenSource: startToken ? 'powershell' : null,
      executablePath: ExecutablePath ?? null
    });
  }
  return out;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;
const DMTF = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/;
const MS_DATE = /^\/Date\((-?\d+)\)\/$/;

function millis(fraction: string | undefined): number {
  // Truncate (never round) so the same instant always yields the same token.
  return fraction ? Number(fraction.slice(0, 3).padEnd(3, '0')) : 0;
}

/**
 * Normalizes a Win32_Process CreationDate (ISO 8601 from `ToString('o')`, the
 * PowerShell 5.1 `/Date(ms)/` form or raw CIM DMTF) to `YYYY-MM-DDTHH:mm:ss.sssZ`.
 * Returns `null` for anything unrecognized.
 */
export function normalizeCreationDate(raw: string): string | null {
  const text = raw.trim();
  let epoch: number | null = null;
  const iso = ISO.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s, frac, zone] = iso;
    const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), millis(frac));
    epoch = base - zoneOffsetMs(zone);
  }
  const dmtf = iso ? null : DMTF.exec(text);
  if (dmtf) {
    const [, y, mo, d, h, mi, s, frac, sign, offset] = dmtf;
    const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), millis(frac));
    epoch = base - (sign === '-' ? -1 : 1) * Number(offset) * 60_000;
  }
  const msDate = iso || dmtf ? null : MS_DATE.exec(text);
  if (msDate) epoch = Number(msDate[1]);
  if (epoch === null || !Number.isFinite(epoch)) return null;
  const date = new Date(epoch);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function zoneOffsetMs(zone: string | undefined): number {
  if (!zone || zone === 'Z') return 0;
  const sign = zone.startsWith('-') ? -1 : 1;
  const [hours, minutes] = zone.slice(1).split(':').map(Number);
  return sign * ((hours ?? 0) * 60 + (minutes ?? 0)) * 60_000;
}

/** True for tokens produced by `normalizeCreationDate` (legacy tokens were raw ticks). */
export function isNormalizedCreationDate(token: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(token);
}

export function tasklistArgs(pid: number | null): string[] {
  const filter = pid === null ? [] : ['/FI', `PID eq ${Math.trunc(pid)}`];
  return [...filter, '/FO', 'CSV', '/NH'];
}

/** Splits one CSV line (tasklist quotes every field; `""` escapes a quote). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parses `tasklist /FO CSV /NH` output into `pid → lower-cased image name`.
 * Lines that are not process rows (e.g. the localized "INFO: no tasks" message)
 * are ignored.
 */
export function parseTasklistCsv(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('"')) continue;
    const [image, pidText] = splitCsvLine(line);
    if (!image || !pidText || !/^\d+$/.test(pidText)) continue;
    out.set(Number(pidText), image.toLowerCase());
  }
  return out;
}

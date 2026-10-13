/**
 * Editing model for site → cookie-file rules (pure). Rows can be incomplete
 * while the user types; only valid rows are sent to the host.
 */
import type { CookieBindingDto } from '../../../../shared/contracts/dto.ts';
import { LIMITS } from '../../../../shared/contracts/host-protocol.ts';

export interface BindingRow {
  readonly id: string;
  readonly siteHost: string;
  readonly cookieName: string;
}

const HOST_PATTERN = /^[a-z0-9.-]+$/;

/** Accepts pasted URLs too: `https://www.Site.com/path` → `site.com`. */
export function normalizeSiteHost(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split(/[/?#]/)[0] ?? '';
  value = value
    .replace(/:\d+$/, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/^www\./, '');
  return value;
}

export function isValidRow(row: BindingRow, files: ReadonlySet<string>): boolean {
  const host = normalizeSiteHost(row.siteHost);
  return host.length > 0 && host.length <= 253 && HOST_PATTERN.test(host) && files.has(row.cookieName);
}

/** Valid rows, normalized, first rule per host wins (same order the host applies them). */
export function committableBindings(rows: readonly BindingRow[], files: ReadonlySet<string>): CookieBindingDto[] {
  const seen = new Set<string>();
  const out: CookieBindingDto[] = [];
  for (const row of rows) {
    if (!isValidRow(row, files)) continue;
    const siteHost = normalizeSiteHost(row.siteHost);
    if (seen.has(siteHost)) continue;
    seen.add(siteHost);
    out.push({ id: row.id, siteHost, cookieName: row.cookieName });
    if (out.length >= LIMITS.maxCookieBindings) break;
  }
  return out;
}

export function sameBindings(a: readonly CookieBindingDto[], b: readonly CookieBindingDto[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.id === b[index]?.id && item.siteHost === b[index]?.siteHost && item.cookieName === b[index]?.cookieName
    )
  );
}

export function removeRow(rows: readonly BindingRow[], id: string): BindingRow[] {
  return rows.filter((row) => row.id !== id);
}

export function updateRow(
  rows: readonly BindingRow[],
  id: string,
  patch: Partial<Omit<BindingRow, 'id'>>
): BindingRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

/**
 * Adopts a host snapshot without losing what the user is still typing:
 * - rows that are not committable (incomplete, invalid, duplicate host) stay as typed;
 * - committed rows take the host's version, or disappear when the host no longer has them
 *   (removed in another window, cookie file deleted);
 * - host rows unknown here (added in another window) are appended.
 */
export function mergeHostBindings(
  local: readonly BindingRow[],
  host: readonly CookieBindingDto[],
  files: ReadonlySet<string>
): BindingRow[] {
  const hostById = new Map(host.map((binding) => [binding.id, binding]));
  const committable = new Set(committableBindings(local, files).map((binding) => binding.id));
  const kept = new Set<string>();
  const out: BindingRow[] = [];
  for (const row of local) {
    const fromHost = hostById.get(row.id);
    if (fromHost) {
      out.push(fromHost);
      kept.add(row.id);
    } else if (!committable.has(row.id)) {
      out.push(row);
    }
  }
  for (const binding of host) if (!kept.has(binding.id)) out.push(binding);
  return out;
}

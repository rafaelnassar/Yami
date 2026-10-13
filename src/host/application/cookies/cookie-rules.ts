/**
 * Pure rules for cookie files and site → cookie bindings.
 */
import type { CookieBindingDto } from '../../../shared/contracts/dto.ts';
import { parseHttpUrl } from '../../../shared/domain/url.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import {
  hasForbiddenFileNameChars,
  hasPathSeparator,
  hasTrailingDotOrSpace,
  isWindowsReservedName
} from '../../domain/library/file-names.ts';

const MAX_COOKIE_NAME_LENGTH = 128;
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/**
 * A cookie file name is written to disk when a download runs (`<job>/<name>`),
 * so it must be a portable file name: no leading dot, no reserved device name.
 */
export function validateCookieFileName(raw: string): Result<string, AppErrorData> {
  const name = raw;
  const stem = name.replace(/\.txt$/i, '');
  const invalid =
    name.length === 0 ||
    name.length > MAX_COOKIE_NAME_LENGTH ||
    name !== name.trim() ||
    name.startsWith('.') ||
    !/\.txt$/i.test(name) ||
    stem.length === 0 ||
    hasPathSeparator(name) ||
    hasForbiddenFileNameChars(name) ||
    hasTrailingDotOrSpace(stem) ||
    isWindowsReservedName(name);
  return invalid ? err(appError(ErrorCode.COOKIES_INVALID_NAME)) : ok(name);
}

/** UTF-8 size without allocating a buffer (the legacy check counted UTF-16 units). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/**
 * `Danbooru.Donmai.us`, `.pixiv.net`, `www.x.com`, `https://www.x.com/a` →
 * `danbooru.donmai.us`, `pixiv.net`, `x.com`, `x.com`. `null` when not a host.
 */
export function normalizeSiteHost(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (host.includes('://')) host = parseHttpUrl(host)?.hostname ?? '';
  host = host
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/^www\./, '');
  return host.length > 0 && host.length <= 253 && HOST.test(host) ? host : null;
}

/**
 * Validates and normalizes the full binding list sent by the UI. Every cookie
 * name must exist. Duplicates (same id or same site) keep the first entry,
 * which is also the one automatic resolution would pick.
 */
export function normalizeBindings(
  bindings: readonly CookieBindingDto[],
  knownCookieNames: ReadonlySet<string>
): Result<CookieBindingDto[], AppErrorData> {
  const out: CookieBindingDto[] = [];
  const ids = new Set<string>();
  const sites = new Set<string>();
  for (const [index, binding] of bindings.entries()) {
    if (!knownCookieNames.has(binding.cookieName)) {
      return err(appError(ErrorCode.COOKIES_NOT_FOUND, { name: binding.cookieName }));
    }
    const siteHost = normalizeSiteHost(binding.siteHost);
    if (siteHost === null) return err(appError(ErrorCode.VALIDATION_FAILED, { path: `bindings.${index}.siteHost` }));
    if (ids.has(binding.id) || sites.has(siteHost)) continue;
    ids.add(binding.id);
    sites.add(siteHost);
    out.push({ id: binding.id, siteHost, cookieName: binding.cookieName });
  }
  return ok(out);
}

export interface MergedBindings {
  readonly bindings: readonly CookieBindingDto[];
  readonly added: number;
}

/**
 * Merges bindings imported from the legacy renderer into the current ones:
 * current bindings win on the same site, unknown cookie files and unusable hosts
 * are skipped, colliding ids get a fresh id, and the total is capped. Running it
 * twice adds nothing the second time.
 */
export function mergeImportedBindings(
  current: readonly CookieBindingDto[],
  incoming: readonly CookieBindingDto[],
  knownCookieNames: ReadonlySet<string>,
  max: number,
  newId: () => string
): MergedBindings {
  const bindings = [...current];
  const ids = new Set(current.map((binding) => binding.id));
  const sites = new Set(current.map((binding) => binding.siteHost));
  let added = 0;
  for (const binding of incoming) {
    if (bindings.length >= max) break;
    const siteHost = normalizeSiteHost(binding.siteHost);
    if (siteHost === null || sites.has(siteHost) || !knownCookieNames.has(binding.cookieName)) continue;
    const id = ids.has(binding.id) ? newId() : binding.id;
    ids.add(id);
    sites.add(siteHost);
    bindings.push({ id, siteHost, cookieName: binding.cookieName });
    added += 1;
  }
  return { bindings, added };
}

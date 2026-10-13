/**
 * Netscape cookie file validation (the format gallery-dl and yt-dlp read).
 *
 * Accepted: optional `# Netscape HTTP Cookie File` header, comments, blank
 * lines, `#HttpOnly_` prefixed cookie lines; every cookie line has exactly 7
 * TAB-separated fields: domain, include-subdomains (TRUE/FALSE), path,
 * secure (TRUE/FALSE), expiry (integer), name, value. At least one cookie line.
 * The size limit is measured in UTF-8 bytes (legacy counted UTF-16 units).
 */
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { LIMITS } from '../../../shared/contracts/host-protocol.ts';

export const MAX_COOKIE_DOMAINS = 20;
const HTTP_ONLY_PREFIX = '#HttpOnly_';
const BOOLEAN_FIELD = /^(?:TRUE|FALSE)$/i;
const EXPIRY_FIELD = /^-?\d{1,20}$/;
const DOMAIN_FIELD = /^[^\s]+$/;

export interface ParsedCookieFile {
  readonly cookieCount: number;
  /** Distinct lower-case domains without the leading dot (first 20, in file order). */
  readonly domains: readonly string[];
}

function invalid(line: number): Result<never, AppErrorData> {
  return err(appError(ErrorCode.COOKIES_INVALID_FORMAT, { line }));
}

function cookieFields(line: string): string[] | null {
  const body = line.startsWith(HTTP_ONLY_PREFIX) ? line.slice(HTTP_ONLY_PREFIX.length) : line;
  const fields = body.split('\t');
  if (fields.length !== 7) return null;
  const [domain, subdomains, path, secure, expiry] = fields;
  if (!domain || !DOMAIN_FIELD.test(domain)) return null;
  if (!subdomains || !BOOLEAN_FIELD.test(subdomains)) return null;
  if (path === undefined || path === '') return null;
  if (!secure || !BOOLEAN_FIELD.test(secure)) return null;
  if (!expiry || !EXPIRY_FIELD.test(expiry)) return null;
  return fields;
}

export function parseNetscapeCookies(content: string): Result<ParsedCookieFile, AppErrorData> {
  if (Buffer.byteLength(content, 'utf8') > LIMITS.maxCookieFileBytes) {
    return err(appError(ErrorCode.COOKIES_TOO_LARGE, { maxBytes: LIMITS.maxCookieFileBytes }));
  }
  const text = content.startsWith('﻿') ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  const domains: string[] = [];
  const seen = new Set<string>();
  let cookieCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/\r$/, '');
    if (line.trim() === '') continue;
    if (line.startsWith('#') && !line.startsWith(HTTP_ONLY_PREFIX)) continue;
    const fields = cookieFields(line);
    if (!fields) return invalid(index + 1);
    cookieCount += 1;
    const domain = (fields[0] ?? '').toLowerCase().replace(/^\.+/, '');
    if (domain && !seen.has(domain) && domains.length < MAX_COOKIE_DOMAINS) {
      seen.add(domain);
      domains.push(domain);
    }
  }
  if (cookieCount === 0) return invalid(0);
  return ok({ cookieCount, domains });
}

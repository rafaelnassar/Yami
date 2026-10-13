/** Pure helpers to find http(s) URLs in clipboard text and compare them with the history. */
import { parseHttpUrl, siteHostOf } from '../../../shared/domain/url.ts';

const CANDIDATE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[)\].,;:!?}]+$/;

/** Every distinct http(s) URL in `text`, in order of appearance (at most `max`). */
export function extractHttpUrls(text: string, max = 500): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CANDIDATE)) {
    if (out.length >= max) break;
    const candidate = match[0].replace(TRAILING_PUNCTUATION, '');
    const url = parseHttpUrl(candidate);
    if (!url || !url.hostname) continue;
    const value = url.toString();
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function firstHttpUrl(text: string): string | null {
  return extractHttpUrls(text, 1)[0] ?? null;
}

/**
 * Canonical form used to compare a copied URL with the download history: no fragment,
 * no trailing slash on non-root paths, lower-case host (via URL parsing).
 */
export function normalizeForHistory(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

export interface HistoryIndex {
  readonly urls: ReadonlySet<string>;
  readonly hosts: ReadonlySet<string>;
}

export function buildHistoryIndex(sourceUrls: readonly string[]): HistoryIndex {
  const urls = new Set<string>();
  const hosts = new Set<string>();
  for (const raw of sourceUrls) {
    const normalized = normalizeForHistory(raw);
    if (!normalized) continue;
    urls.add(normalized);
    const host = siteHostOf(normalized);
    if (host) hosts.add(host);
  }
  return { urls, hosts };
}

/** A URL is suggested when its site is known from the history but the exact URL is new. */
export function shouldSuggest(
  url: string,
  history: HistoryIndex
): { readonly url: string; readonly siteHost: string } | null {
  const normalized = normalizeForHistory(url);
  if (!normalized || history.urls.has(normalized)) return null;
  const siteHost = siteHostOf(normalized);
  if (!siteHost || !history.hosts.has(siteHost)) return null;
  return { url: normalized, siteHost };
}

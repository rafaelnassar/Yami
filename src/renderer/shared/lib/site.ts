/**
 * Site helpers for URLs shown in the UI (pure).
 * Favicons load from Google's public favicon service (domain-only query); letter chip is the fallback.
 */
import { siteHostOf } from '../../../shared/domain/url.ts';

/** Host without `www.` (or the raw text before the first `/` for non-URLs). */
export function siteLabel(sourceUrl: string): string {
  if (!sourceUrl) return '';
  const host = siteHostOf(sourceUrl);
  if (host) return host;
  return sourceUrl.replace(/^https?:\/\//i, '').split('/')[0] ?? '';
}

/** Muted palette (dark UI contrast) used for avatars; same family as folder colours. */
export const AVATAR_COLORS: readonly string[] = [
  '#94A3B8',
  '#60A5FA',
  '#38BDF8',
  '#22D3EE',
  '#818CF8',
  '#A78BFA',
  '#C084FC',
  '#E879F9',
  '#F472B6',
  '#FB7185',
  '#F87171',
  '#FB923C',
  '#FBBF24',
  '#A3E635',
  '#4ADE80',
  '#34D399',
  '#2DD4BF'
];

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);

/** The "brand" label of a host: `x.com` → `x`, `www.bbc.co.uk` → `bbc`, `danbooru.donmai.us` → `donmai`. */
export function siteBrand(host: string): string {
  const parts = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  let index = parts.length - 2;
  if (parts.length >= 3 && SECOND_LEVEL.has(parts[index] ?? '') && (parts[parts.length - 1] ?? '').length === 2)
    index -= 1;
  return parts[index] ?? parts[0] ?? '';
}

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(value);
}

export interface SiteAvatar {
  readonly letter: string;
  readonly color: string;
}

export function siteAvatar(host: string): SiteAvatar {
  const brand = siteBrand(host);
  const letter = (brand.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  const color = AVATAR_COLORS[hash(brand || host) % AVATAR_COLORS.length] ?? '#94A3B8';
  return { letter, color };
}

/** Google favicon URL (`size` clamped to what the service accepts). Served from gstatic (matches CSP). */
export function siteFaviconUrl(host: string, size = 32): string | null {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (!normalized || !/^[a-z0-9.-]+$/i.test(normalized)) return null;
  const sz = Math.max(16, Math.min(64, Math.round(size)));
  const page = encodeURIComponent(`https://${normalized}/`);
  return `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${page}&size=${sz}`;
}

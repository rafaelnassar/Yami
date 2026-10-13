/**
 * Conversation titles derived from the source URL (legacy `titleFromUrl`,
 * spec 02 §4.5). The title is data (shown as-is, renamable), never UI copy.
 */

export const MAX_TITLE_LENGTH = 120;

/** Tabs/routes that do not identify content (e.g. `x.com/user/media`). */
const GENERIC_PATH_SEGMENTS = new Set([
  'about',
  'album',
  'albums',
  'all',
  'articles',
  'channel',
  'clips',
  'explore',
  'feed',
  'files',
  'followers',
  'following',
  'gallery',
  'grid',
  'highlights',
  'home',
  'igtv',
  'image',
  'images',
  'latest',
  'likes',
  'list',
  'lists',
  'media',
  'photo',
  'photos',
  'playlist',
  'popular',
  'posts',
  'preview',
  'recommended',
  'reels',
  'saved',
  'search',
  'shorts',
  'status',
  'stories',
  'tagged',
  'topics',
  'trending',
  'tv',
  'verified_followers',
  'video',
  'videos',
  'watch',
  'with_replies'
]);

const QUERY_TITLE_KEYS = ['tags', 'q', 'search', 'query', 'screen_name', 'username', 'v', 'list'] as const;

const TWITTER_RESERVED_SEGMENTS = new Set([
  'about',
  'compose',
  'download',
  'explore',
  'hashtag',
  'hashtags',
  'help',
  'home',
  'i',
  'intent',
  'jobs',
  'login',
  'messages',
  'notifications',
  'oauth',
  'privacy',
  'search',
  'settings',
  'share',
  'signup',
  'tos'
]);

function hostWithoutWww(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

function isTwitterHost(hostname: string): boolean {
  const host = hostWithoutWww(hostname);
  return host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com';
}

export function isGenericPathSegment(segment: string): boolean {
  return GENERIC_PATH_SEGMENTS.has(segment.toLowerCase());
}

function pathSegments(pathname: string): string[] {
  try {
    return decodeURIComponent(pathname).split('/').filter(Boolean);
  } catch {
    return pathname.split('/').filter(Boolean);
  }
}

function queryTitle(url: URL): string {
  for (const key of QUERY_TITLE_KEYS) {
    const value = (url.searchParams.get(key) ?? '').trim();
    if (value) return value;
  }
  return '';
}

function twitterTitle(url: URL, segments: readonly string[]): string {
  const first = segments[0] ?? '';
  if (first && !TWITTER_RESERVED_SEGMENTS.has(first.toLowerCase()) && !isGenericPathSegment(first)) return first;
  const statusIndex = segments.findIndex((segment) => segment.toLowerCase() === 'status');
  const afterStatus = statusIndex >= 0 ? segments[statusIndex + 1] : undefined;
  if (afterStatus) return afterStatus;
  return queryTitle(url);
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Visible name of a conversation: the last meaningful path segment (generic tabs
 * like `media`, `likes`, `watch` are skipped), a known query parameter, or the host.
 */
export function titleFromUrl(rawUrl: string): string {
  const url = parse(rawUrl);
  if (!url) return rawUrl.trim().slice(0, MAX_TITLE_LENGTH);
  const host = hostWithoutWww(url.hostname) || url.hostname;
  const segments = pathSegments(url.pathname);

  if (isTwitterHost(url.hostname)) {
    return (twitterTitle(url, segments) || host).slice(0, MAX_TITLE_LENGTH);
  }

  const meaningful = [...segments];
  while (meaningful.length > 1 && isGenericPathSegment(meaningful.at(-1) ?? '')) meaningful.pop();
  let pathLabel = meaningful.at(-1) ?? '';
  if (pathLabel && isGenericPathSegment(pathLabel)) pathLabel = '';

  return (pathLabel || queryTitle(url) || host).slice(0, MAX_TITLE_LENGTH);
}

/**
 * Whether a stored title is a leftover generic tab name (e.g. `media`) that the
 * current rules would replace (legacy `repairGenericConversationTitles`).
 */
export function shouldRepairTitle(currentTitle: string, rawUrl: string): boolean {
  const next = titleFromUrl(rawUrl);
  if (!next || next === currentTitle) return false;
  const url = parse(rawUrl);
  if (!url) return false;
  const last = pathSegments(url.pathname).at(-1) ?? '';
  return Boolean(last) && currentTitle.toLowerCase() === last.toLowerCase() && isGenericPathSegment(last);
}

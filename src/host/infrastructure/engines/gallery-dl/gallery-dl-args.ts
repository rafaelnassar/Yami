/**
 * gallery-dl argument vector (spec 03 §2.2).
 *
 * `-o KEY=VALUE` keys are config paths: extractor options only take effect under
 * `extractor.` (the legacy short forms such as `pixiv.ugoira` were ignored, Q6);
 * output options live under `output.`, the cache database under `cache.`
 * (top-level `"cache": {"file": …}`). Secrets never appear here: they travel in a
 * private `-c` config file (Q22). The URL follows `--` (Q2).
 */
import path from 'node:path';
import type { HostPlatform } from '../../../application/ports/engines.ts';

/** gallery-dl's SQLite cache (login sessions, cookies, OAuth access tokens), kept for one run. */
export const GALLERY_DL_CACHE_FILE = 'gallery-dl-cache.sqlite3';

/** Reddit layout: `Reddit/<subreddit>/<author>/` or `Reddit/<user>/` under the destination. */
const REDDIT_FILENAME = '{id} {num:>02} {title}.{extension}';
const REDDIT_SUBREDDIT_DIRECTORY = ['Reddit', '{subreddit}', '{author}'];
const REDDIT_USER_DIRECTORY = ['Reddit', '{user[name]}'];
const REDDIT_DIRECTORY_BY_SUBCATEGORY = {
  "subcategory.startswith('user')": REDDIT_USER_DIRECTORY,
  '': REDDIT_SUBREDDIT_DIRECTORY
};

/**
 * Reddit's network security answers the `.json` endpoints of the REST API with
 * "You've been blocked by network security." for browser-like User-Agents — including
 * the Firefox one gallery-dl picks on its own: the REST API clears its per-request
 * headers, so the extractor's User-Agent is the only one that reaches Reddit. A feed
 * reader is served normally, and scoping the value to `extractor.reddit` leaves every
 * other site's requests (and the default User-Agent) untouched.
 */
const REDDIT_USER_AGENT = 'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)';

/** `-o KEY=VALUE`, JSON-encoding anything that is not a plain string (lists, objects, booleans). */
export function galleryDlOption(key: string, value: unknown): [string, string] {
  return ['-o', `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`];
}

/**
 * `-o KEY="<path>"`. gallery-dl first tries to parse the value as JSON, so a path
 * is always sent as a JSON string: it can never be re-read as a number/`null`, and
 * Windows backslashes survive the JSON unescaping.
 */
export function galleryDlPathOption(key: string, filePath: string | null): [string, string] {
  return ['-o', `${key}=${JSON.stringify(filePath)}`];
}

/**
 * `cache.file` inside the private per-run secrets dir (wiped whenever the run ends,
 * pause and app quit included), so the tokens gallery-dl derives from our vaulted
 * secrets never persist in the default `%APPDATA%\gallery-dl` / `~/.cache/gallery-dl`
 * database nor in the temp dir kept for resumable downloads (gallery-dl writes its
 * `.part` files next to the output, so it needs no temp dir). Without a secrets dir,
 * `null` disables the database cache (gallery-dl falls back to memory).
 */
function cacheFileOf(secretDir: string | null, platform: HostPlatform): string | null {
  if (!secretDir) return null;
  return (platform === 'win32' ? path.win32 : path.posix).join(secretDir, GALLERY_DL_CACHE_FILE);
}

export interface GalleryDlArgsInput {
  readonly url: string;
  /** `--destination`: files land in `<downloadDir>/<category>/…`. */
  readonly downloadDir: string;
  /** Private per-run secrets dir (`JobPaths.dir`): holds gallery-dl's cache database. */
  readonly secretDir: string | null;
  readonly platform: HostPlatform;
  readonly cookieFile: string | null;
  /** Private config file with secrets (`-c`), loaded right after `--config-ignore`. */
  readonly secretConfigFile: string | null;
  /** Let gallery-dl hand Fanbox/Facebook videos to its `ytdl` downloader (needs the yt_dlp module, Q7). */
  readonly delegateVideosToYtdl: boolean;
}

export function buildGalleryDlArgs(input: GalleryDlArgsInput): string[] {
  // --config-ignore: never load the user's config (it may hold `exec` post-processors).
  const args: string[] = ['--config-ignore'];
  if (input.secretConfigFile) args.push('-c', input.secretConfigFile);
  args.push(
    '--destination',
    input.downloadDir,
    '--retries',
    '5',
    '--http-timeout',
    '30',
    '--windows-filenames',
    // Pipe mode prints bare final paths (`# ` prefix for skips) whatever the stdout type.
    ...galleryDlOption('output.mode', 'pipe'),
    // Redirected output would otherwise use the ANSI code page on Windows (Q3).
    ...galleryDlOption('output.stdout', 'utf-8'),
    ...galleryDlOption('output.stderr', 'utf-8'),
    // Sessions/tokens (e.g. Pixiv access tokens from our refresh token) stay in the job dir.
    ...galleryDlPathOption('cache.file', cacheFileOf(input.secretDir, input.platform)),
    // Resume = re-spawn: files already written are skipped; never write cookies back.
    ...galleryDlOption('extractor.skip', true),
    ...galleryDlOption('extractor.cookies-update', false),
    ...galleryDlOption('extractor.deviantart.original', true),
    ...galleryDlOption('extractor.deviantart.quality', 'png'),
    ...galleryDlOption('extractor.pixiv.ugoira', 'original'),
    ...galleryDlOption('extractor.danbooru.ugoira', true),
    ...galleryDlOption('extractor.reddit.filename', REDDIT_FILENAME),
    ...galleryDlOption('extractor.reddit.api', 'rest'),
    ...galleryDlOption('extractor.reddit.user-agent', REDDIT_USER_AGENT),
    // `dash` hands Reddit's DASH manifest URL to the `ytdl` downloader; `ytdl` would hand it
    // the post URL instead, which yt-dlp's Reddit extractor now refuses to resolve without a
    // logged-in account ("Account authentication is required"), failing every video post.
    // Pinned outside the Q7 gate on purpose: it is already gallery-dl's default, so the gate
    // cannot change the outcome, and pinning it survives a future change of that default.
    ...galleryDlOption('extractor.reddit.videos', 'dash'),
    ...galleryDlOption('extractor.reddit.parent-directory', true),
    ...galleryDlOption('extractor.reddit.directory', REDDIT_DIRECTORY_BY_SUBCATEGORY),
    ...galleryDlOption('extractor.reddit.subreddit.directory', REDDIT_SUBREDDIT_DIRECTORY),
    ...galleryDlOption('extractor.reddit.user.directory', REDDIT_USER_DIRECTORY)
  );
  if (input.delegateVideosToYtdl) {
    args.push(
      ...galleryDlOption('extractor.fanbox.embeds', 'ytdl'),
      ...galleryDlOption('extractor.facebook.videos', 'ytdl')
    );
  }
  if (input.cookieFile) args.push('--cookies', input.cookieFile);
  args.push('--', input.url);
  return args;
}

/**
 * Pure path heuristics shared by the engine parsers. They work on paths exactly as
 * the engines print them (Windows or POSIX, absolute or relative) and never touch
 * the file system.
 */
import { baseName } from '../../../shared/domain/media.ts';

/** Longest text still considered a path (Windows long paths can exceed MAX_PATH). */
const MAX_PATH_TEXT = 4096;
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC_SHARE = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/;
/** Characters Windows forbids inside a path (after the drive prefix). */
const INVALID_WINDOWS_CHARS = /[<>:"|?*]/;
/** `file.py:123:` — Python warning/traceback locations are not downloaded files. */
const SOURCE_LOCATION = /:\d+:/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** Drops the Win32 `\\?\` / `\\?\UNC\` long-path prefixes so the rules below apply. */
function withoutLongPathPrefix(text: string): string {
  if (text.startsWith('\\\\?\\UNC\\')) return `\\\\${text.slice(8)}`;
  if (text.startsWith('\\\\?\\')) return text.slice(4);
  return text;
}

/**
 * True when a whole line looks like a file path printed by an engine: a drive,
 * UNC, POSIX-absolute or `./`/`.\` path ending in a short extension. URLs, bare
 * words and extension-less names are rejected.
 */
export function looksLikePath(text: string): boolean {
  if (!text || text.length > MAX_PATH_TEXT || !/[\\/]/.test(text)) return false;
  if (URL_SCHEME.test(text)) return false;
  const candidate = withoutLongPathPrefix(text);
  if (!EXTENSION.test(candidate)) return false;
  if (WINDOWS_DRIVE.test(candidate)) return !INVALID_WINDOWS_CHARS.test(candidate.slice(2));
  if (candidate.startsWith('\\\\')) return UNC_SHARE.test(candidate) && !INVALID_WINDOWS_CHARS.test(candidate.slice(2));
  if (candidate.startsWith('/') || candidate.startsWith('./') || candidate.startsWith('.\\')) {
    return !SOURCE_LOCATION.test(candidate);
  }
  return false;
}

/** Fragments, `.part`/`.ytdl` partials and `.temp` intermediates — never a final file. */
export function isTransientDownloadPath(filePath: string): boolean {
  return /\.(?:part|ytdl)$/i.test(filePath) || /\.(?:f\d+|temp)\.[A-Za-z0-9]{1,8}(?:\.part)?$/i.test(filePath);
}

/** yt-dlp metadata/subtitle sidecars (never media). Images are judged by context instead (spec 03 Q16). */
export function isMetadataSidecarPath(filePath: string): boolean {
  return (
    /\.(?:info|live_chat)\.json$/i.test(filePath) ||
    /\.description$/i.test(filePath) ||
    /\.(?:vtt|srt|ass|ssa|lrc|ttml|srv3|dfxp)$/i.test(filePath)
  );
}

/** Image extensions yt-dlp uses for `--write-thumbnail` output. */
export function isThumbnailImagePath(filePath: string): boolean {
  return /\.(?:webp|jpe?g|png|avif|gif)$/i.test(filePath);
}

/**
 * Media stem shared by a download, its format fragments and its thumbnail:
 * `title [id].f137.mp4.part` → `title [id]`.
 */
export function mediaStemOf(filePath: string): string {
  const name = baseName(filePath).replace(/\.(?:part|ytdl)$/i, '');
  const dot = name.lastIndexOf('.');
  const withoutExtension = dot > 0 ? name.slice(0, dot) : name;
  return withoutExtension.replace(/\.(?:f\d+|temp)$/i, '');
}

/** Stable key for comparing two spellings of the same path printed by one engine run. */
export function pathKey(filePath: string): string {
  return filePath.normalize('NFC').replace(/\\/g, '/');
}

function isWindowsStylePath(filePath: string): boolean {
  return WINDOWS_DRIVE.test(filePath) || filePath.startsWith('\\\\');
}

function comparable(filePath: string, windows: boolean): string {
  const normalized = filePath.normalize('NFC');
  const unified = windows ? normalized.replace(/\//g, '\\').toLowerCase() : normalized;
  return unified.replace(/[\\/]+$/, '');
}

/**
 * True when `filePath` is `dir` or lies inside it. Windows-style directories are
 * compared case-insensitively with either separator; POSIX ones exactly.
 */
export function isInsideDir(filePath: string, dir: string | null | undefined): boolean {
  if (!dir || !filePath) return false;
  const windows = isWindowsStylePath(dir);
  const root = comparable(dir, windows);
  if (!root) return false;
  const candidate = comparable(filePath, windows);
  return candidate === root || candidate.startsWith(`${root}${windows ? '\\' : '/'}`);
}

/** Media classification by file extension (pure, shared by host and renderer). */

export const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'other'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

const EXTENSIONS: Readonly<Record<Exclude<MediaType, 'other'>, readonly string[]>> = {
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.heic', '.heif', '.jfif', '.tif', '.tiff'],
  video: ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.flv', '.ts', '.3gp'],
  audio: ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus', '.aac'],
  document: ['.pdf', '.txt', '.json', '.zip', '.cbz', '.epub']
};

const BY_EXTENSION = new Map<string, MediaType>(
  Object.entries(EXTENSIONS).flatMap(([type, exts]) => exts.map((ext) => [ext, type as MediaType] as const))
);

/** Returns the lower-case extension including the dot (`.jpg`), or `''`. */
export function extensionOf(fileName: string): string {
  const base = baseName(fileName);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function mediaTypeOf(fileName: string): MediaType {
  return BY_EXTENSION.get(extensionOf(fileName)) ?? 'other';
}

/** Cross-platform basename that accepts both `/` and `\` separators. */
export function baseName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/** Cross-platform dirname that accepts both separators. */
export function dirName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index > 0 ? normalized.slice(0, index) : '';
}

/** Sidecar/metadata files produced by yt-dlp that should not appear as media. */
const SIDECAR = /\.(?:info\.json|description|live_chat\.json|vtt|srt|ass|ssa|lrc|ttml|srv3|dfxp|part|ytdl|temp)$/i;

export function isSidecarFile(fileName: string): boolean {
  return SIDECAR.test(baseName(fileName));
}

/** Lower-cased file stem without the media extension (and without `.info.json`-like suffixes). */
export function mediaStem(fileName: string): string {
  const base = baseName(fileName).replace(/\.(?:info\.json|live_chat\.json|description)$/i, '');
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/**
 * Removes sidecars and video thumbnails (an image with the same stem as a video
 * in the same list). O(n): builds the set of video stems once.
 */
export function filterMediaFiles<T extends { readonly name: string }>(files: readonly T[]): T[] {
  const videoStems = new Set<string>();
  for (const file of files) {
    if (mediaTypeOf(file.name) === 'video') videoStems.add(mediaStem(file.name));
  }
  return files.filter((file) => {
    if (isSidecarFile(file.name)) return false;
    return !(mediaTypeOf(file.name) === 'image' && videoStems.has(mediaStem(file.name)));
  });
}

/** Extensions that must never be launched from the app without an explicit, native confirmation. */
const DANGEROUS_EXTENSIONS = new Set([
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.msi',
  '.msp',
  '.mst',
  '.scr',
  '.pif',
  '.cpl',
  '.dll',
  '.sys',
  '.drv',
  '.ocx',
  '.ps1',
  '.psm1',
  '.psd1',
  '.ps1xml',
  '.psc1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.wsc',
  '.hta',
  '.msc',
  '.lnk',
  '.url',
  '.reg',
  '.inf',
  '.chm',
  '.jar',
  '.appx',
  '.appxbundle',
  '.msix',
  '.msixbundle',
  '.application',
  '.gadget',
  '.scf',
  '.iso',
  '.img',
  '.vhd',
  '.vhdx',
  '.library-ms',
  '.search-ms',
  '.settingcontent-ms',
  '.sh',
  '.command',
  '.app',
  '.pkg',
  '.dmg',
  '.run',
  '.bin',
  '.desktop',
  '.appimage',
  '.deb',
  '.rpm',
  '.py',
  '.pyw',
  '.mht',
  '.mhtml',
  '.docm',
  '.xlsm',
  '.pptm',
  '.dotm',
  '.xltm'
]);

export type FileRisk = 'safe' | 'caution' | 'blocked';

/**
 * Risk policy for opening a file with the OS default handler.
 * - `safe`: known media/document types.
 * - `blocked`: executables/scripts/shortcuts — never opened by the app (reveal in folder instead).
 * - `caution`: anything else — requires a native confirmation dialog.
 */
export function fileOpenRisk(fileName: string): FileRisk {
  const ext = extensionOf(fileName);
  if (!ext) return 'caution';
  if (DANGEROUS_EXTENSIONS.has(ext)) return 'blocked';
  if (BY_EXTENSION.has(ext)) return 'safe';
  return 'caution';
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json'
};

/** MIME type for previewable media; `null` for anything the preview protocol must not serve. */
export function previewMimeOf(fileName: string): string | null {
  const type = mediaTypeOf(fileName);
  if (type !== 'image' && type !== 'video' && type !== 'audio') return null;
  return MIME_BY_EXTENSION[extensionOf(fileName)] ?? null;
}

/**
 * Identity of a media file behind a `yami-media://` token. It is captured when the token
 * is issued (right after the host validated the path) and re-checked on every request,
 * so a file, directory, symlink or junction swapped in later is never served.
 */
export interface MediaFileIdentity {
  /** Canonical path: every symlink/junction resolved. */
  readonly realPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  readonly mtimeNs: bigint;
}

/**
 * Same canonical path and same file object. Size/mtime are deliberately not compared when
 * the filesystem reports file ids: a still-growing or touched file (`--mtime`) is still the
 * validated file. Filesystems without stable ids (some network shares report 0) fall back
 * to size + mtime as the fingerprint.
 */
export function isSameMediaFile(registered: MediaFileIdentity, current: MediaFileIdentity): boolean {
  if (registered.realPath !== current.realPath || registered.dev !== current.dev) return false;
  if (registered.ino === 0n || current.ino === 0n) {
    return registered.size === current.size && registered.mtimeNs === current.mtimeNs;
  }
  return registered.ino === current.ino;
}

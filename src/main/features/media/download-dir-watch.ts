/**
 * Revokes every `yami-media://` token when the download folder changes. The protocol handler
 * re-checks each token's file identity per request, but not that the file is still inside the
 * download folder: that was checked by the host when the token was issued. Renderers recover
 * through their load-error retry (fresh URLs are validated against the new folder).
 */
export type DownloadDirObserver = (downloadDir: string) => void;

/**
 * Returns the function to call with every download folder main learns about (host state, the
 * folder dialog). The first value only sets the baseline; `onChange` runs on each later change.
 */
export function watchDownloadDir(onChange: () => void): DownloadDirObserver {
  let current: string | null = null;
  return (downloadDir) => {
    if (current !== null && downloadDir !== current) onChange();
    current = downloadDir;
  };
}

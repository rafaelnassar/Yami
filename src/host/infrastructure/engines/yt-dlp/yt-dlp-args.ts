/**
 * yt-dlp argument vector (spec 03 §2.1). No shell is ever involved: every value is
 * its own argv element and the URL follows `--`, so it can never be read as an
 * option (Q2). Only fixed, app-chosen flags are emitted — nothing that executes
 * user-provided commands (`--exec`, `--postprocessor-args`, `--config-location`).
 */

/**
 * `<extractor>/<uploader>/<title> [<id>].<ext>` relative to `--paths`. Title and
 * uploader are capped in bytes so the final path stays under MAX_PATH (Q34).
 */
export const YTDLP_OUTPUT_TEMPLATE =
  '%(extractor)s/%(uploader,playlist_uploader,channel,id).80B/%(title).150B [%(id)s].%(ext)s';

/** Machine-readable progress prefix parsed by `YtDlpLineParser` (Q27). */
export const YTDLP_PROGRESS_PREFIX = '[yami-progress]';

export const YTDLP_PROGRESS_TEMPLATE = `download:${YTDLP_PROGRESS_PREFIX} %(progress.status)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s`;

export interface YtDlpArgsInput {
  readonly url: string;
  /** Home path (`--paths`): files land in `<downloadDir>/<extractor>/…`. */
  readonly downloadDir: string;
  /** Private scratch dir for fragments/merge/fixups (`-P temp:`). */
  readonly tempDir: string;
  readonly ffmpegPath: string | null;
  readonly denoPath: string | null;
  readonly cookieFile: string | null;
  /** Already validated `--cookies-from-browser` spec, or `null`. */
  readonly browserCookies: string | null;
}

/**
 * YouTube needs a JS runtime + EJS challenge scripts, otherwise the CDN answers 403.
 * Only the Deno the probe resolved (managed, or found in a trusted directory) is
 * enabled, by absolute path. Without one, `--no-js-runtimes` clears yt-dlp's
 * default (`deno` looked up in PATH) instead of passing a bare `deno`.
 *
 * CLI compatibility: `--js-runtimes`, `--no-js-runtimes` and `--remote-components`
 * all first shipped in yt-dlp 2025.11.12 (the manifest pin). `--remote-components`
 * was already sent unconditionally, so the minimum yt-dlp version does not change.
 */
function jsRuntimeArgs(denoPath: string | null): string[] {
  return denoPath ? ['--js-runtimes', `deno:${denoPath}`] : ['--no-js-runtimes'];
}

export function buildYtDlpArgs(input: YtDlpArgsInput): string[] {
  const args: string[] = [
    '--ignore-config',
    // Redirected output would otherwise use the ANSI code page on Windows (Q3).
    '--encoding',
    'utf-8',
    ...jsRuntimeArgs(input.denoPath),
    '--remote-components',
    'ejs:github',
    '--paths',
    input.downloadDir
  ];
  // Merge/fixup/metadata happen in a short private path; [MoveFiles] then reports the final file.
  if (input.tempDir) args.push('-P', `temp:${input.tempDir}`);
  args.push(
    '--output',
    YTDLP_OUTPUT_TEMPLATE,
    // Without ffmpeg `bv*+ba` would force a merge that aborts after downloading the streams.
    '--format',
    input.ffmpegPath ? 'bv*+ba/b' : 'b/bv/ba',
    '--concurrent-fragments',
    '8',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--socket-timeout',
    '30',
    // Pause/resume and app quit = kill + re-spawn: the `.part` files in the temp dir survive
    // (JobWorkspace.removeSecrets keeps it), so they are continued; finished files are never overwritten.
    '--continue',
    '--no-overwrites',
    '--windows-filenames',
    '--mtime'
  );
  // Without a resolved ffmpeg there is no `--ffmpeg-location`: yt-dlp then searches PATH (e.g. for
  // fixups), which the engine environment limits to trusted directories. There is no option every
  // yt-dlp version knows to disable ffmpeg outright, and a bogus location only prints warnings.
  if (input.ffmpegPath) {
    args.push(
      '--ffmpeg-location',
      input.ffmpegPath,
      '--embed-metadata',
      // Chromium <video> cannot play MKV: merge into mp4 (or webm for VP9/AV1+Opus)…
      '--merge-output-format',
      'mp4/webm',
      // …and remux anything else to mp4 while keeping webm as is (Q8: `mp4/webm` made `/webm` dead).
      '--remux-video',
      'webm>webm/mp4'
    );
  }
  // Cover next to the video for the grid. No --embed-thumbnail: AVIF breaks yt-dlp's ffmpeg on Windows.
  // No --no-warnings: warnings are useful diagnostics and are shown as non-fatal log lines (Q27).
  args.push('--write-thumbnail', '--newline', '--progress-template', YTDLP_PROGRESS_TEMPLATE);
  if (input.cookieFile) args.push('--cookies', input.cookieFile);
  else if (input.browserCookies) args.push('--cookies-from-browser', input.browserCookies);
  args.push('--', input.url);
  return args;
}

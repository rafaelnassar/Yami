/**
 * Stateful interpreter of one yt-dlp run's output (one instance per spawn).
 *
 * File discovery follows the legacy rules (spec 03 §3.3) with these changes:
 * - a `[download] Destination:` becomes `pending-file`; the matching 100 % line
 *   becomes `promote-pending` only while that pending path is still unpromoted;
 * - with a known temp dir (`ParserContext.tempDir`) outputs inside it are never
 *   reported as final files: post-processor outputs there update the pending path;
 *   the `[MoveFiles]` line reports the final one;
 * - thumbnails are recognised by context (the thumbnail writer message, or an image
 *   sharing the stem of the item's media) instead of by extension, so image media
 *   downloaded by yt-dlp is counted (spec 03 Q16);
 * - the machine-readable `--progress-template` line is parsed (spec 03 Q27);
 * - with a known download dir, only paths inside it (or inside the temp dir, as
 *   pending) are reported; UNC paths only when that dir is on the share
 *   (`isReportableOutputPath`: a forged line must not make the core stat `\\evil\x`).
 */
import type { LineParser, ParserContext } from '../../../application/ports/engines.ts';
import type { ParsedLine } from '../../../domain/engines/parsed-line.ts';
import { baseName } from '../../../../shared/domain/media.ts';
import { classifyEngineError } from '../error-classifier.ts';
import {
  isInsideDir,
  isMetadataSidecarPath,
  isThumbnailImagePath,
  isTransientDownloadPath,
  mediaStemOf,
  pathKey
} from '../engine-paths.ts';
import { normalizeEngineLine, stripWrappingQuotes } from '../line-normalizer.ts';
import { isReportableOutputPath, type OutputRoots } from '../output-path-guard.ts';
import { normalizeEta, normalizeSpeed, parsePercent, speedAndEtaOf } from '../progress-fields.ts';
import { YTDLP_PROGRESS_PREFIX } from './yt-dlp-args.ts';

const NOISE: ParsedLine = { kind: 'noise' };

/** A path line we refuse to report stays a plain log line. */
function rejected(text: string): ParsedLine {
  return { kind: 'info', level: 'info', text };
}

const ERROR_LINE = /^(?:\[download\]\s+)?ERROR:\s*(.*)$/i;
const WARNING_LINE = /^(?:\[download\]\s+)?WARNING:/i;
const DEBUG_LINE = /^\[debug\]/i;
const ITEM_COUNTER = /^\[download\]\s+Downloading item\s+\d+/i;
const DESTINATION = /^\[download\]\s+Destination:\s+(.+)$/i;
const MOVE_FILES = /^\[MoveFiles\]\s+Moving file\s+"([^"]+)"\s+to\s+"([^"]+)"/i;
const ALREADY_DOWNLOADED = /^\[download\]\s+(.+?)\s+has already been downloaded/i;
const POSTPROCESS_INTO = /^\[(?:Merger|ExtractAudio|Fixup\w+|ffmpeg)\][^"]*(?:into|to)\s+"([^"]+)"/i;
const POSTPROCESS_QUOTED = /^\[(?:Merger|ExtractAudio|ffmpeg)\][^"]*"([^"]+)"/i;
const POSTPROCESS_DESTINATION = /^\[(?:VideoRemuxer|VideoConvertor|ExtractAudio)\].*?Destination:\s+(.+)$/i;
const THUMBNAIL_WRITE = /^\[info\]\s+Writing\s+(?:video\s+|playlist\s+)?thumbnail\b.*?\s+to:\s+(.+)$/i;
const DEFAULT_PROGRESS = /^\[download\]\s+([\d.]+)%/;
const OTHER_DOWNLOAD_COUNTER = /^\[download\]\s+\d/i;
const TEMPLATE_PROGRESS = new RegExp(
  `^${YTDLP_PROGRESS_PREFIX.replace(/[[\]-]/g, '\\$&')}\\s*(\\w+)\\|([^|]*)\\|([^|]*)\\|([^|]*)$`
);

export class YtDlpLineParser implements LineParser {
  readonly #tempDir: string | null;
  /** Where reported paths may live; empty when the download dir is unknown. */
  readonly #roots: OutputRoots;
  /** Last announced destination that has not been reported as final yet. */
  #pending: string | null = null;
  readonly #thumbnails = new Set<string>();
  readonly #mediaStems = new Set<string>();
  readonly #mediaNames = new Set<string>();

  constructor(context: ParserContext = {}) {
    this.#tempDir = context.tempDir ?? null;
    const downloadDir = context.downloadDir ?? null;
    this.#roots = downloadDir ? [downloadDir, this.#tempDir] : [];
  }

  parse(line: string): ParsedLine {
    const text = normalizeEngineLine(line);
    if (!text) return NOISE;

    const error = ERROR_LINE.exec(text);
    if (error) {
      const message = error[1] ?? '';
      return { kind: 'error', errorKind: classifyEngineError(message), message, fatal: true, text };
    }
    if (WARNING_LINE.test(text)) return { kind: 'info', level: 'warn', text };
    if (DEBUG_LINE.test(text) || ITEM_COUNTER.test(text)) return NOISE;
    return this.#parseFiles(text) ?? this.#parseProgress(text) ?? { kind: 'info', level: 'info', text };
  }

  #parseFiles(text: string): ParsedLine | null {
    let match = DESTINATION.exec(text);
    if (match) return this.#destination(stripWrappingQuotes(match[1] ?? ''), text);

    match = MOVE_FILES.exec(text);
    if (match) return this.#moved(stripWrappingQuotes(match[1] ?? ''), stripWrappingQuotes(match[2] ?? ''), text);

    match = ALREADY_DOWNLOADED.exec(text);
    if (match) return this.#alreadyDownloaded(stripWrappingQuotes(match[1] ?? ''), text);

    match = POSTPROCESS_INTO.exec(text) ?? POSTPROCESS_QUOTED.exec(text);
    if (match) return this.#output(stripWrappingQuotes(match[1] ?? ''), text);

    match = POSTPROCESS_DESTINATION.exec(text);
    if (match) {
      // Remux/convert outputs happen before [MoveFiles]: they only refine the pending path.
      const path = stripWrappingQuotes(match[1] ?? '');
      return this.#isCountable(path) ? this.#setPending(path, text) : NOISE;
    }

    match = THUMBNAIL_WRITE.exec(text);
    if (match) {
      this.#thumbnails.add(pathKey(stripWrappingQuotes(match[1] ?? '')));
      return { kind: 'info', level: 'info', text };
    }
    return null;
  }

  #parseProgress(text: string): ParsedLine | null {
    const template = TEMPLATE_PROGRESS.exec(text);
    if (template) {
      const finished = (template[1] ?? '').toLowerCase() === 'finished';
      const percent = parsePercent(template[2]) ?? (finished ? 100 : null);
      return this.#progress(percent, normalizeSpeed(template[3]), normalizeEta(template[4]), finished, text);
    }
    const progress = DEFAULT_PROGRESS.exec(text);
    if (progress) {
      const percent = parsePercent(progress[1]) ?? 0;
      const { speed, eta } = speedAndEtaOf(text);
      return this.#progress(percent, speed, eta, false, text);
    }
    return OTHER_DOWNLOAD_COUNTER.test(text) ? NOISE : null;
  }

  #progress(
    percent: number | null,
    speed: string | null,
    eta: string | null,
    finished: boolean,
    text: string
  ): ParsedLine {
    const complete = finished || (percent !== null && percent >= 99.9);
    // Single-file download without post-processing: the pending destination is final now.
    if (complete && this.#pending !== null && !this.#inTemp(this.#pending)) {
      this.#pending = null;
      return { kind: 'promote-pending', text };
    }
    return { kind: 'progress', percent, speed, eta };
  }

  #destination(path: string, text: string): ParsedLine {
    if (this.#isCountable(path)) return this.#setPending(path, text);
    // Format fragments (`x.f137.mp4`) still name the item: needed to recognise its thumbnail.
    if (path) this.#mediaStems.add(mediaStemOf(path));
    return NOISE;
  }

  #moved(from: string, to: string, text: string): ParsedLine {
    if (this.#thumbnails.has(pathKey(from)) || this.#isThumbnail(to)) {
      this.#thumbnails.add(pathKey(to));
      return NOISE;
    }
    return this.#output(to, text);
  }

  #alreadyDownloaded(path: string, text: string): ParsedLine {
    if (!this.#isCountable(path)) return { kind: 'info', level: 'muted', text };
    // A finished temp copy from an interrupted run: [MoveFiles] reports the final path.
    if (this.#inTemp(path)) return this.#setPending(path, text);
    if (!this.#isReportable(path)) return rejected(text);
    this.#rememberMedia(path);
    return { kind: 'file', status: 'skipped', path, text };
  }

  /** A written output (merger, move, …): final unless it still lives in the temp dir. */
  #output(path: string, text: string): ParsedLine {
    if (!this.#isCountable(path)) return NOISE;
    if (this.#inTemp(path)) return this.#setPending(path, text);
    if (!this.#isReportable(path)) return rejected(text);
    this.#rememberMedia(path);
    this.#pending = null;
    return { kind: 'file', status: 'downloaded', path, text };
  }

  #setPending(path: string, text: string): ParsedLine {
    if (!this.#isReportable(path)) return rejected(text);
    this.#rememberMedia(path);
    this.#pending = path;
    return { kind: 'pending-file', path, text };
  }

  #isReportable(path: string): boolean {
    return isReportableOutputPath(path, this.#roots);
  }

  #rememberMedia(path: string): void {
    this.#mediaStems.add(mediaStemOf(path));
    this.#mediaNames.add(baseName(path).normalize('NFC'));
  }

  #isThumbnail(path: string): boolean {
    if (this.#thumbnails.has(pathKey(path))) return true;
    // yt-dlp names thumbnails after the media (`<stem>.webp` next to `<stem>.mp4`).
    return (
      isThumbnailImagePath(path) &&
      this.#mediaStems.has(mediaStemOf(path)) &&
      !this.#mediaNames.has(baseName(path).normalize('NFC'))
    );
  }

  #isCountable(path: string): boolean {
    return Boolean(path) && !isTransientDownloadPath(path) && !isMetadataSidecarPath(path) && !this.#isThumbnail(path);
  }

  #inTemp(path: string): boolean {
    return isInsideDir(path, this.#tempDir);
  }
}

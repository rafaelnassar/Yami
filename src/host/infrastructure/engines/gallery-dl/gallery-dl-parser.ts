/**
 * Interpreter of one gallery-dl run's output (spec 03 §3.4), with fixes:
 * - log lines are recognised only by their leading `[category][level]` (or
 *   `[level]`) prefix, so a downloaded path containing `[error]` is a file, not an
 *   error (Q13);
 * - `[warning]` is a non-fatal log line, `[error]` a fatal engine error;
 * - with a known destination dir, any printed path inside it counts even when
 *   `looksLikePath` would reject it (UNC share, no extension — Q15);
 * - with a known destination dir, paths outside it are never reported, and UNC paths
 *   only when the destination is on that share (`isReportableOutputPath`).
 */
import type { LineParser, ParserContext } from '../../../application/ports/engines.ts';
import type { ParsedLine } from '../../../domain/engines/parsed-line.ts';
import { classifyEngineError } from '../error-classifier.ts';
import { isInsideDir, isTransientDownloadPath, looksLikePath } from '../engine-paths.ts';
import { normalizeEngineLine } from '../line-normalizer.ts';
import { isReportableOutputPath } from '../output-path-guard.ts';
import { parsePercent, speedAndEtaOf } from '../progress-fields.ts';

const NOISE: ParsedLine = { kind: 'noise' };

/** `[pixiv][error] msg`, `[downloader.http][warning] msg`, `[error] msg`. */
const LOG_LINE = /^(?:\[([^\]]*)\])?\[(error|critical|warning|info|debug)\]\s*(.*)$/i;
const PROGRESS = /^\[download\]\s+([\d.]+)%/;
/** Pipe mode: `# <path>` = already present (skipped). */
const SKIPPED = /^#\s+(.+)$/;
/** Terminal mode: `* <path>` = downloaded. */
const DOWNLOADED_MARK = /^\*\s+(.+)$/;

function isMediaOutput(path: string): boolean {
  return Boolean(path) && !/\.json$/i.test(path) && !isTransientDownloadPath(path);
}

export class GalleryDlLineParser implements LineParser {
  readonly #downloadDir: string | null;

  constructor(context: ParserContext = {}) {
    this.#downloadDir = context.downloadDir ?? null;
  }

  parse(line: string): ParsedLine {
    const text = normalizeEngineLine(line);
    if (!text) return NOISE;

    const log = LOG_LINE.exec(text);
    if (log) return this.#logLine(log[1] || null, (log[2] ?? '').toLowerCase(), log[3] ?? '', text);

    const progress = PROGRESS.exec(text);
    if (progress) {
      const { speed, eta } = speedAndEtaOf(text);
      return { kind: 'progress', percent: parsePercent(progress[1]), speed, eta };
    }

    const skipped = SKIPPED.exec(text);
    if (skipped) return this.#file('skipped', (skipped[1] ?? '').trim(), text);

    const marked = DOWNLOADED_MARK.exec(text);
    if (marked) return this.#file('downloaded', (marked[1] ?? '').trim(), text);

    // Pipe mode prints each downloaded file as a bare path.
    if ((looksLikePath(text) || isInsideDir(text, this.#downloadDir)) && isMediaOutput(text)) {
      return this.#file('downloaded', text, text);
    }
    return { kind: 'info', level: 'info', text };
  }

  #file(status: 'downloaded' | 'skipped', path: string, text: string): ParsedLine {
    if (!isMediaOutput(path)) return NOISE;
    // A forged line (e.g. a title with a newline) must not make the core stat an arbitrary/UNC path.
    if (!isReportableOutputPath(path, [this.#downloadDir])) return { kind: 'info', level: 'info', text };
    return { kind: 'file', status, path, text };
  }

  #logLine(category: string | null, level: string, message: string, text: string): ParsedLine {
    switch (level) {
      case 'error':
      case 'critical':
        return {
          kind: 'error',
          errorKind: classifyEngineError(message, { source: category }),
          message,
          fatal: true,
          text
        };
      case 'warning':
        return { kind: 'info', level: 'warn', text };
      case 'debug':
        return NOISE;
      default:
        return { kind: 'info', level: 'info', text };
    }
  }
}

/**
 * Feeds engine output lines of one run into its `Download`:
 * parse → normalize (absolute paths, untrusted/private paths dropped, redaction) →
 * `Download.applyLine` → media file rows (committed together with the counters and
 * log offset) + `files.added` / `log` events + OS download marks.
 */
import type { LogEntryDto, MediaFileDto } from '../../../shared/contracts/dto.ts';
import type { Clock } from '../../../shared/kernel/clock.ts';
import { baseName, extensionOf, mediaTypeOf } from '../../../shared/domain/media.ts';
import { stripUrlSecrets } from '../../../shared/domain/url.ts';
import type { Download } from '../../domain/downloads/download.ts';
import type { DetectedFile } from '../../domain/downloads/run-progress.ts';
import type { ParsedLine } from '../../domain/engines/parsed-line.ts';
import type { DownloadedFileMarker, FileSystemPort } from '../ports/files.ts';
import type { MediaFileRepository, NewMediaFile, TransactionRunner } from '../ports/persistence.ts';
import type { Logger } from '../ports/system.ts';
import type { ActiveRun } from './download-registry.ts';
import { chunked, type DownloadJournal } from './journal.ts';
import type { OutputPaths } from './output-paths.ts';
import type { Redactor } from './redactor.ts';

export interface LineProcessorDeps {
  readonly files: MediaFileRepository;
  readonly tx: TransactionRunner;
  readonly journal: DownloadJournal;
  readonly paths: OutputPaths;
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly logger: Logger;
  readonly sensitiveDirs: readonly string[];
  readonly fileSystem: FileSystemPort | null;
  readonly fileMarker: DownloadedFileMarker | null;
}

const NOISE: ParsedLine = { kind: 'noise' };

export class LineProcessor {
  readonly #deps: LineProcessorDeps;

  constructor(deps: LineProcessorDeps) {
    this.#deps = deps;
  }

  /** Applies `lines` and advances the log offset. Returns true when progress changed. */
  async process(download: Download, run: ActiveRun, lines: readonly string[]): Promise<boolean> {
    let changed = false;
    const logs: LogEntryDto[] = [];
    const detected: DetectedFile[] = [];
    for (const raw of lines) {
      const line = this.#normalize(this.#parse(run, raw), run);
      const effect = download.applyLine(line);
      changed ||= effect.changed;
      if (effect.file?.status === 'downloaded') detected.push(effect.file);
      const entry = this.#logEntry(line, download.id);
      if (entry) logs.push(entry);
    }
    download.advanceLog(run.reader.offset);
    this.#deps.journal.logEntries(logs);
    if (detected.length > 0) await this.#storeFiles(download, run, detected);
    return changed;
  }

  #parse(run: ActiveRun, raw: string): ParsedLine {
    try {
      return run.parser.parse(raw);
    } catch (error) {
      this.#deps.logger.warn('engine line parser failed', { downloadId: run.downloadId, error: String(error) });
      return NOISE;
    }
  }

  #normalize(line: ParsedLine, run: ActiveRun): ParsedLine {
    const { redactor } = this.#deps;
    switch (line.kind) {
      case 'file':
      case 'pending-file': {
        const path = this.#deps.paths.resolve(run.downloadDir, line.path);
        // yt-dlp temp copies are replaced by the final (moved/merged) path later.
        if (this.#isPrivate(path, run)) return NOISE;
        if (!this.#deps.paths.isTrusted(path, [run.outputDir, run.downloadDir])) {
          this.#deps.logger.warn('engine path outside the download dir ignored', { downloadId: run.downloadId });
          return { kind: 'info', level: 'warn', text: redactor.text(line.text) };
        }
        return { ...line, path, text: redactor.text(line.text) };
      }
      case 'info':
        return { ...line, text: redactor.text(line.text) };
      case 'error':
        return { ...line, message: redactor.text(line.message), text: redactor.text(line.text) };
      default:
        return line;
    }
  }

  #isPrivate(path: string, run: ActiveRun): boolean {
    return this.#deps.paths.isInsideAny(path, [run.tempDir, ...this.#deps.sensitiveDirs]);
  }

  #logEntry(line: ParsedLine, conversationId: string): LogEntryDto | null {
    const ts = this.#deps.clock.now();
    const entry = (level: LogEntryDto['level'], text: string): LogEntryDto => ({
      ts,
      level,
      text,
      code: null,
      params: {},
      conversationId
    });
    switch (line.kind) {
      case 'info':
        return entry(line.level, line.text);
      case 'file':
        return entry(line.status === 'downloaded' ? 'success' : 'muted', line.text);
      case 'error':
        return entry('error', line.text);
      default:
        return null;
    }
  }

  /**
   * Records downloaded files. The rows are inserted in the same transaction that
   * saves the counters and log offset, so a restarted host never sees stored files
   * that its persisted counters do not include (re-attach would undercount).
   */
  async #storeFiles(download: Download, run: ActiveRun, detected: readonly DetectedFile[]): Promise<void> {
    const { files, tx, journal, clock, logger } = this.#deps;
    const rows: NewMediaFile[] = [];
    for (const file of detected) rows.push(await this.#row(download.id, file.path));
    const added: MediaFileDto[] = [];
    const stored = tx.transaction(() => {
      if (!journal.commit(download)) return false;
      for (const row of rows) {
        try {
          const dto = files.add(row);
          if (dto) added.push(dto);
        } catch (error) {
          logger.warn('media file insert failed', { conversationId: download.id, error: String(error) });
        }
      }
      return true;
    });
    if (!stored) {
      logger.warn('download row vanished while recording files', { downloadId: download.id });
      return;
    }
    run.persistedOffset = download.logOffset;
    run.lastPersistAt = clock.now();
    for (const items of chunked(added)) journal.publish({ type: 'files.added', items });
    for (const row of rows) this.#mark(row.path, download.sourceUrl);
  }

  async #row(conversationId: string, path: string): Promise<NewMediaFile> {
    return {
      conversationId,
      path,
      name: baseName(path).normalize('NFC'),
      mediaType: mediaTypeOf(path),
      extension: extensionOf(path),
      sizeBytes: await this.#sizeOf(path),
      createdAt: this.#deps.clock.now()
    };
  }

  async #sizeOf(path: string): Promise<number | null> {
    const fs = this.#deps.fileSystem;
    if (!fs) return null;
    try {
      const stat = await fs.stat(path);
      return stat && !stat.isDirectory ? stat.sizeBytes : null;
    } catch {
      return null;
    }
  }

  /** Mark-of-the-Web / quarantine, fire and forget. The URL is stripped of query strings and credentials. */
  #mark(path: string, sourceUrl: string): void {
    const marker = this.#deps.fileMarker;
    if (!marker) return;
    const onError = (error: unknown): void =>
      this.#deps.logger.warn('marking downloaded file failed', { error: String(error) });
    try {
      marker.mark(path, stripUrlSecrets(sourceUrl)).catch(onError);
    } catch (error) {
      onError(error);
    }
  }
}

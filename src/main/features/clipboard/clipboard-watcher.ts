/**
 * Opt-in clipboard watcher (`settings.clipboardWatch`, off by default). While enabled it
 * polls the clipboard every second; when the text changes to a URL from a site already in
 * the download history — and that exact URL was neither downloaded nor dismissed — the
 * tray panel is shown (without focus) with the suggestion.
 *
 * Unlike the legacy poller it never spawns the host (it only asks a ready host), never
 * steals focus, and a hidden panel does not count as a dismissal (only an explicit one).
 */
import type { ClipboardSuggestionDto } from '../../../shared/contracts/ipc.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import type { Result } from '../../../shared/kernel/result.ts';
import { describeError, type Logger } from '../../infrastructure/logger.ts';
import type { Cancel, Timers } from '../../infrastructure/timers.ts';
import { buildHistoryIndex, firstHttpUrl, shouldSuggest, type HistoryIndex } from './clipboard-urls.ts';

export interface ClipboardWatcherDeps {
  readonly readText: () => string;
  readonly fetchHistory: () => Promise<Result<{ readonly sourceUrls: readonly string[] }, AppErrorData>>;
  readonly hostReady: () => boolean;
  readonly panelVisible: () => boolean;
  readonly isDismissed: (url: string) => boolean;
  readonly suggest: (suggestion: ClipboardSuggestionDto) => void;
  readonly timers: Timers;
  readonly now: () => number;
  readonly logger: Logger;
  readonly pollMs?: number;
  readonly historyTtlMs?: number;
}

export class ClipboardWatcher {
  readonly #deps: ClipboardWatcherDeps;
  #stop: Cancel | null = null;
  #lastText = '';
  #busy = false;
  #history: { index: HistoryIndex; at: number } | null = null;

  constructor(deps: ClipboardWatcherDeps) {
    this.#deps = deps;
  }

  get running(): boolean {
    return this.#stop !== null;
  }

  setEnabled(enabled: boolean): void {
    if (enabled) this.start();
    else this.stop();
  }

  start(): void {
    if (this.#stop) return;
    // Whatever is already on the clipboard when the feature turns on is not a new copy.
    this.#lastText = this.#read().trim();
    this.#stop = this.#deps.timers.every(() => void this.tick(), this.#deps.pollMs ?? 1_000);
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
    this.#history = null;
  }

  /** Forget the cached history (e.g. after a download was started). */
  invalidateHistory(): void {
    this.#history = null;
  }

  async tick(): Promise<void> {
    if (this.#busy) return;
    const text = this.#read().trim();
    if (!text || text === this.#lastText) return;
    this.#lastText = text;

    const url = firstHttpUrl(text);
    if (!url || this.#deps.panelVisible() || this.#deps.isDismissed(url) || !this.#deps.hostReady()) return;

    this.#busy = true;
    try {
      const history = await this.#historyIndex();
      if (!history || !this.running) return;
      const suggestion = shouldSuggest(url, history);
      if (suggestion && !this.#deps.isDismissed(suggestion.url)) this.#deps.suggest(suggestion);
    } catch (error) {
      this.#deps.logger.warn('clipboard suggestion failed', describeError(error));
    } finally {
      this.#busy = false;
    }
  }

  async #historyIndex(): Promise<HistoryIndex | null> {
    const now = this.#deps.now();
    if (this.#history && now - this.#history.at < (this.#deps.historyTtlMs ?? 60_000)) return this.#history.index;
    const result = await this.#deps.fetchHistory();
    if (!result.ok) return null;
    this.#history = { index: buildHistoryIndex(result.value.sourceUrls), at: now };
    return this.#history.index;
  }

  #read(): string {
    try {
      return this.#deps.readText();
    } catch {
      return '';
    }
  }
}

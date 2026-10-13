/**
 * OS notifications for finished downloads/batches (pushed by the host; the legacy
 * polling fallback is gone). Respects `settings.notifications`, localized with the
 * current locale, de-duplicated for 10 s; a click shows the main window.
 */
import { Notification } from 'electron';
import type { BatchFinishedDto, DownloadFinishedDto } from '../../../shared/contracts/dto.ts';
import { translatorFor } from '../../../shared/i18n/catalog.ts';
import type { SettingsReader } from '../../infrastructure/settings-store.ts';
import { describeError, type Logger } from '../../infrastructure/logger.ts';
import { batchNotification, downloadNotification, type NotificationContent } from './notification-text.ts';

const DEDUP_MS = 10_000;
const MAX_ALIVE = 32;

export interface NotifierDeps {
  readonly settings: SettingsReader;
  readonly iconPath: string | null;
  readonly onClick: () => void;
  readonly now: () => number;
  readonly logger: Logger;
}

export class Notifier {
  readonly #deps: NotifierDeps;
  readonly #recent = new Map<string, number>();
  /** Keeps shown notifications referenced so a GC can't drop their click handler (Windows). */
  readonly #alive = new Set<Notification>();

  constructor(deps: NotifierDeps) {
    this.#deps = deps;
  }

  downloadFinished(download: DownloadFinishedDto): void {
    this.#show((t) => downloadNotification(download, t));
  }

  batchFinished(batch: BatchFinishedDto): void {
    this.#show((t) => batchNotification(batch, t));
  }

  #show(build: (t: ReturnType<typeof translatorFor>) => NotificationContent): void {
    const settings = this.#deps.settings.get();
    if (!settings.notifications || !Notification.isSupported()) return;
    const content = build(translatorFor(settings.locale));
    if (this.#isDuplicate(content.key)) return;
    try {
      const notification = new Notification({
        id: content.key,
        groupId: content.groupId,
        groupTitle: 'Yami',
        title: content.title,
        body: content.body,
        silent: content.silent,
        urgency: content.urgency,
        timeoutType: 'default',
        ...(this.#deps.iconPath ? { icon: this.#deps.iconPath } : {})
      });
      const release = (): void => {
        this.#alive.delete(notification);
      };
      notification.on('click', () => {
        release();
        this.#deps.onClick();
      });
      notification.on('close', release);
      notification.on('failed', release);
      if (this.#alive.size >= MAX_ALIVE) {
        const oldest = this.#alive.values().next();
        if (!oldest.done) this.#alive.delete(oldest.value);
      }
      this.#alive.add(notification);
      notification.show();
    } catch (error) {
      this.#deps.logger.warn('notification failed', describeError(error));
    }
  }

  #isDuplicate(key: string): boolean {
    const now = this.#deps.now();
    const last = this.#recent.get(key);
    if (last !== undefined && now - last < DEDUP_MS) return true;
    this.#recent.set(key, now);
    if (this.#recent.size > 64) {
      for (const [entry, at] of this.#recent) if (now - at > DEDUP_MS) this.#recent.delete(entry);
    }
    return false;
  }
}

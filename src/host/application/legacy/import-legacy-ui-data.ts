/**
 * `legacy.importUiData` (main-only, once) — imports what the legacy renderer kept
 * in localStorage: sidebar folders, conversation → folder assignments and site →
 * cookie bindings. Idempotent: running it again imports nothing new and never
 * overrides choices already made in the new app.
 */
import { LIMITS, type CommandPayload, type CommandResult } from '../../../shared/contracts/host-protocol.ts';
import type { AppErrorData } from '../../../shared/kernel/errors.ts';
import { newId } from '../../../shared/kernel/ids.ts';
import { ok, type Result } from '../../../shared/kernel/result.ts';
import { createFolder, sanitizeImportedFolderColor, sanitizeImportedFolderName } from '../../domain/library/folder.ts';
import { mergeImportedBindings } from '../cookies/cookie-rules.ts';
import type { CookiesSnapshotBuilder } from '../cookies/cookies-snapshot.ts';
import type { DownloadRepository, FolderRepository, TransactionRunner } from '../ports/persistence.ts';
import type { CookieVault } from '../ports/secrets.ts';
import type { EventSink } from '../ports/system.ts';
import type { SettingsStore } from '../settings/settings-store.ts';

type Payload = CommandPayload<'legacy.importUiData'>;
type Counts = CommandResult<'legacy.importUiData'>;

export interface LegacyUiImportDeps {
  readonly folders: Pick<FolderRepository, 'get' | 'save' | 'assign' | 'nextPosition'>;
  readonly records: Pick<DownloadRepository, 'get'>;
  readonly vault: Pick<CookieVault, 'list'>;
  readonly settings: Pick<SettingsStore, 'read' | 'update'>;
  readonly tx: TransactionRunner;
  readonly events: EventSink;
  readonly snapshots: Pick<CookiesSnapshotBuilder, 'publishChanged'>;
  /** Id for an imported binding whose id collides with an existing one. */
  readonly newBindingId?: () => string;
}

export class LegacyUiImportService {
  readonly #deps: LegacyUiImportDeps;
  readonly #newBindingId: () => string;

  constructor(deps: LegacyUiImportDeps) {
    this.#deps = deps;
    this.#newBindingId = deps.newBindingId ?? (() => newId('cb-'));
  }

  async importUiData(payload: Payload): Promise<Result<Counts, AppErrorData>> {
    const { vault, tx, events, snapshots } = this.#deps;
    // Async work first: everything below runs in one synchronous transaction.
    const knownCookies = new Set((await vault.list()).map((file) => file.name));
    const counts = tx.transaction((): Counts => ({
      folders: this.#importFolders(payload.folders),
      assignments: this.#importAssignments(payload.folderMap),
      bindings: this.#importBindings(payload.cookieBindings, knownCookies)
    }));
    if (counts.folders > 0 || counts.assignments > 0) events.publish({ type: 'folders.changed' });
    if (counts.bindings > 0) await snapshots.publishChanged();
    return ok(counts);
  }

  #importFolders(folders: Payload['folders']): number {
    const repository = this.#deps.folders;
    let imported = 0;
    for (const legacy of folders) {
      if (repository.get(legacy.id)) continue;
      const name = sanitizeImportedFolderName(legacy.name);
      if (name === null) continue;
      const folder = createFolder({
        id: legacy.id,
        name,
        color: sanitizeImportedFolderColor(legacy.color),
        position: repository.nextPosition(),
        createdAt: legacy.createdAt,
        collapsed: legacy.collapsed
      });
      if (!folder.ok) continue;
      repository.save(folder.value);
      imported += 1;
    }
    return imported;
  }

  /** Only existing conversations that are still unfiled, and only into existing folders. */
  #importAssignments(folderMap: Payload['folderMap']): number {
    const { folders, records } = this.#deps;
    const folderExists = new Map<string, boolean>();
    const byFolder = new Map<string, string[]>();
    for (const [conversationId, folderId] of Object.entries(folderMap)) {
      if (!folderExists.has(folderId)) folderExists.set(folderId, folders.get(folderId) !== null);
      if (!folderExists.get(folderId)) continue;
      const record = records.get(conversationId);
      if (!record || record.folderId !== null) continue;
      const ids = byFolder.get(folderId);
      if (ids) ids.push(conversationId);
      else byFolder.set(folderId, [conversationId]);
    }
    let assigned = 0;
    for (const [folderId, conversationIds] of byFolder) assigned += folders.assign(conversationIds, folderId);
    return assigned;
  }

  #importBindings(incoming: Payload['cookieBindings'], knownCookies: ReadonlySet<string>): number {
    const { settings } = this.#deps;
    const current = settings.read().cookies.bindings;
    const merged = mergeImportedBindings(current, incoming, knownCookies, LIMITS.maxCookieBindings, this.#newBindingId);
    if (merged.added > 0) {
      settings.update((latest) => ({ ...latest, cookies: { ...latest.cookies, bindings: merged.bindings } }));
    }
    return merged.added;
  }
}

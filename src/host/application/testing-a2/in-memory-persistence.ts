/**
 * In-memory implementations of the persistence ports used by A2 services.
 * Semantics follow the port docs (and SQLite: `assign` counts matched rows).
 */
import type {
  ConversationDetailDto,
  ConversationSummaryDto,
  FolderDto,
  MediaFileDto,
  Page
} from '../../../shared/contracts/dto.ts';
import type {
  ConversationEventRepository,
  ConversationQueries,
  DownloadRecord,
  DownloadRepository,
  FolderRepository,
  HostSettings,
  HostSettingsRepository,
  MediaFileRepository,
  NewConversationEvent,
  NewMediaFile,
  TransactionRunner
} from '../ports/persistence.ts';
import { makeSettings } from './records.ts';

export class InMemoryDownloadRepository implements DownloadRepository {
  readonly rows = new Map<string, DownloadRecord>();
  recentUrls: string[] = [];
  readonly saved: DownloadRecord[] = [];

  constructor(records: readonly DownloadRecord[] = []) {
    for (const record of records) this.rows.set(record.id, record);
  }

  get(id: string): DownloadRecord | null {
    return this.rows.get(id) ?? null;
  }
  listActive(): DownloadRecord[] {
    const active = new Set(['pending', 'running', 'paused']);
    return [...this.rows.values()].filter((record) => active.has(record.status));
  }
  save(record: DownloadRecord): void {
    this.saved.push(record);
    this.rows.set(record.id, record);
  }
  delete(id: string): void {
    this.rows.delete(id);
  }
  nextPosition(): number {
    return this.rows.size;
  }
  recentSourceUrls(limit: number): string[] {
    return this.recentUrls.slice(0, limit);
  }
  listByBatch(batchId: string): DownloadRecord[] {
    return [...this.rows.values()].filter((r) => r.batchId === batchId);
  }
}

export class InMemoryMediaFileRepository implements MediaFileRepository {
  readonly rows: MediaFileDto[] = [];
  readonly renames: Array<{ oldDir: string; newDir: string; caseInsensitive: boolean }> = [];
  #nextId = 1;

  add(file: NewMediaFile): MediaFileDto | null {
    if (this.rows.some((row) => row.conversationId === file.conversationId && row.path === file.path)) return null;
    const row: MediaFileDto = { id: this.#nextId++, ...file };
    this.rows.push(row);
    return row;
  }
  listByConversation(conversationId: string, limit: number, cursor: string | null): Page<MediaFileDto> {
    const all = this.rows.filter((row) => row.conversationId === conversationId);
    const start = cursor ? Number(cursor) : 0;
    const end = start + limit;
    return { items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
  }
  countByConversation(conversationId: string): number {
    return this.rows.filter((row) => row.conversationId === conversationId).length;
  }
  pathsByConversation(conversationId: string): string[] {
    return this.rows.filter((row) => row.conversationId === conversationId).map((row) => row.path);
  }
  deleteByConversation(conversationId: string): number {
    return this.#removeWhere((row) => row.conversationId === conversationId);
  }
  deleteByPaths(paths: readonly string[]): number {
    const set = new Set(paths);
    return this.#removeWhere((row) => set.has(row.path));
  }
  renameDirectory(oldDir: string, newDir: string, caseInsensitive: boolean): number {
    this.renames.push({ oldDir, newDir, caseInsensitive });
    const norm = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);
    let changed = 0;
    for (const [index, row] of this.rows.entries()) {
      const path = norm(row.path);
      const old = norm(oldDir);
      const inside = path === old || path.startsWith(`${old}/`) || path.startsWith(`${old}\\`);
      if (!inside) continue;
      this.rows[index] = { ...row, path: `${newDir}${row.path.slice(oldDir.length)}` };
      changed += 1;
    }
    return changed;
  }
  conversationIdsForPaths(paths: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const path of paths) {
      const row = this.rows.find((candidate) => candidate.path === path && candidate.conversationId !== null);
      if (row?.conversationId) out.set(path, row.conversationId);
    }
    return out;
  }
  pathsReferencedElsewhere(paths: readonly string[], conversationId: string): string[] {
    return paths.filter((path) =>
      this.rows.some((row) => row.path === path && row.conversationId !== null && row.conversationId !== conversationId)
    );
  }
  #removeWhere(predicate: (row: MediaFileDto) => boolean): number {
    const before = this.rows.length;
    const kept = this.rows.filter((row) => !predicate(row));
    this.rows.splice(0, this.rows.length, ...kept);
    return before - kept.length;
  }
}

export class InMemoryEventRepository implements ConversationEventRepository {
  readonly rows: NewConversationEvent[] = [];
  append(event: NewConversationEvent): void {
    this.rows.push(event);
  }
  deleteByConversation(conversationId: string): void {
    const kept = this.rows.filter((row) => row.conversationId !== conversationId);
    this.rows.splice(0, this.rows.length, ...kept);
  }
}

/** Folder repository whose assignments live in the download records (like the SQLite column). */
export class InMemoryFolderRepository implements FolderRepository {
  readonly rows = new Map<string, FolderDto>();
  readonly #downloads: InMemoryDownloadRepository;

  constructor(downloads: InMemoryDownloadRepository, folders: readonly FolderDto[] = []) {
    this.#downloads = downloads;
    for (const folder of folders) this.rows.set(folder.id, folder);
  }

  list(): FolderDto[] {
    return [...this.rows.values()];
  }
  get(id: string): FolderDto | null {
    return this.rows.get(id) ?? null;
  }
  save(folder: FolderDto): void {
    this.rows.set(folder.id, folder);
  }
  delete(id: string): void {
    this.rows.delete(id);
  }
  assign(conversationIds: readonly string[], folderId: string | null): number {
    let changed = 0;
    for (const id of conversationIds) {
      const record = this.#downloads.rows.get(id);
      if (!record) continue;
      this.#downloads.rows.set(id, { ...record, folderId });
      changed += 1;
    }
    return changed;
  }
  unassignAll(folderId: string): void {
    for (const record of this.#downloads.rows.values()) {
      if (record.folderId === folderId) this.#downloads.rows.set(record.id, { ...record, folderId: null });
    }
  }
  nextPosition(): number {
    return Math.max(-1, ...[...this.rows.values()].map((folder) => folder.position)) + 1;
  }
}

export class InMemorySettingsRepository implements HostSettingsRepository {
  current: HostSettings;
  saves = 0;

  constructor(initial: HostSettings = makeSettings()) {
    this.current = initial;
  }
  load(): HostSettings {
    return this.current;
  }
  save(settings: HostSettings): void {
    this.saves += 1;
    this.current = settings;
  }
}

export class CountingTransactionRunner implements TransactionRunner {
  count = 0;
  transaction<T>(work: () => T): T {
    this.count += 1;
    return work();
  }
}

export class FakeConversationQueries implements ConversationQueries {
  page: Page<ConversationSummaryDto> = { items: [], nextCursor: null };
  readonly details = new Map<string, ConversationDetailDto>();
  readonly listCalls: Array<{ limit: number; cursor: string | null }> = [];

  list(limit: number, cursor: string | null): Page<ConversationSummaryDto> {
    this.listCalls.push({ limit, cursor });
    return this.page;
  }
  get(id: string): ConversationDetailDto | null {
    return this.details.get(id) ?? null;
  }
  recentEvents(): [] {
    return [];
  }
}

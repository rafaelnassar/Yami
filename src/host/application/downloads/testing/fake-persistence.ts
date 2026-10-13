/**
 * In-memory `PersistenceContext` for application tests (no SQLite). Records are
 * stored as given; `transaction` just runs the work (no rollback).
 */
import type {
  ConversationDetailDto,
  ConversationEventDto,
  ConversationSummaryDto,
  FolderDto,
  MediaFileDto,
  Page
} from '../../../../shared/contracts/dto.ts';
import { isActiveStatus } from '../../../../shared/domain/download.ts';
import {
  DEFAULT_HOST_SETTINGS,
  type BatchRecord,
  type BatchRepository,
  type ConversationEventRepository,
  type ConversationQueries,
  type DownloadRecord,
  type DownloadRepository,
  type FolderRepository,
  type HostSettings,
  type HostSettingsRepository,
  type MediaFileRepository,
  type NewConversationEvent,
  type NewMediaFile,
  type PersistenceContext,
  type TransactionRunner
} from '../../ports/persistence.ts';

export class InMemoryDownloads implements DownloadRepository {
  readonly rows = new Map<string, DownloadRecord>();
  saves = 0;

  get(id: string): DownloadRecord | null {
    return this.rows.get(id) ?? null;
  }
  listActive(): DownloadRecord[] {
    return [...this.rows.values()].filter((r) => isActiveStatus(r.status)).sort((a, b) => a.position - b.position);
  }
  save(record: DownloadRecord): void {
    this.saves += 1;
    this.rows.set(record.id, { ...record, errorLines: [...record.errorLines] });
  }
  delete(id: string): void {
    this.rows.delete(id);
  }
  nextPosition(): number {
    let max = 0;
    for (const row of this.rows.values()) max = Math.max(max, row.position);
    return max + 1;
  }
  recentSourceUrls(limit: number): string[] {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => r.sourceUrl)
      .slice(0, limit);
  }
  listByBatch(batchId: string): DownloadRecord[] {
    return [...this.rows.values()].filter((r) => r.batchId === batchId);
  }
}

export class InMemoryBatches implements BatchRepository {
  readonly rows = new Map<string, BatchRecord>();
  get(id: string): BatchRecord | null {
    return this.rows.get(id) ?? null;
  }
  save(record: BatchRecord): void {
    this.rows.set(record.id, { ...record });
  }
}

export class InMemoryFiles implements MediaFileRepository {
  readonly rows: MediaFileDto[] = [];
  #nextId = 1;

  add(file: NewMediaFile): MediaFileDto | null {
    if (this.rows.some((r) => r.conversationId === file.conversationId && r.path === file.path)) return null;
    const dto: MediaFileDto = { id: this.#nextId++, ...file };
    this.rows.push(dto);
    return dto;
  }
  listByConversation(conversationId: string, limit: number): Page<MediaFileDto> {
    return { items: this.rows.filter((r) => r.conversationId === conversationId).slice(0, limit), nextCursor: null };
  }
  countByConversation(conversationId: string): number {
    return this.rows.filter((r) => r.conversationId === conversationId).length;
  }
  pathsByConversation(conversationId: string): string[] {
    return this.rows.filter((r) => r.conversationId === conversationId).map((r) => r.path);
  }
  deleteByConversation(conversationId: string): number {
    const before = this.rows.length;
    this.#retain((r) => r.conversationId !== conversationId);
    return before - this.rows.length;
  }
  deleteByPaths(paths: readonly string[]): number {
    const before = this.rows.length;
    this.#retain((r) => !paths.includes(r.path));
    return before - this.rows.length;
  }
  renameDirectory(): number {
    return 0;
  }
  conversationIdsForPaths(paths: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const row of this.rows)
      if (row.conversationId && paths.includes(row.path)) out.set(row.path, row.conversationId);
    return out;
  }
  pathsReferencedElsewhere(paths: readonly string[], conversationId: string): string[] {
    const elsewhere = (r: MediaFileDto): boolean => r.conversationId !== null && r.conversationId !== conversationId;
    return paths.filter((path) => this.rows.some((r) => r.path === path && elsewhere(r)));
  }
  #retain(keep: (row: MediaFileDto) => boolean): void {
    const kept = this.rows.filter(keep);
    this.rows.length = 0;
    this.rows.push(...kept);
  }
}

export class InMemoryEvents implements ConversationEventRepository {
  readonly rows: NewConversationEvent[] = [];
  append(event: NewConversationEvent): void {
    this.rows.push(event);
  }
  deleteByConversation(conversationId: string): void {
    const kept = this.rows.filter((r) => r.conversationId !== conversationId);
    this.rows.length = 0;
    this.rows.push(...kept);
  }
  codesOf(conversationId: string): string[] {
    return this.rows.filter((r) => r.conversationId === conversationId).map((r) => r.code);
  }
}

export class InMemoryFolders implements FolderRepository {
  readonly rows = new Map<string, FolderDto>();
  readonly assignments = new Map<string, string | null>();
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
    for (const id of conversationIds) this.assignments.set(id, folderId);
    return conversationIds.length;
  }
  unassignAll(folderId: string): void {
    for (const [id, folder] of this.assignments) if (folder === folderId) this.assignments.set(id, null);
  }
  nextPosition(): number {
    return this.rows.size;
  }
}

export class InMemorySettings implements HostSettingsRepository {
  value: HostSettings = DEFAULT_HOST_SETTINGS;
  load(): HostSettings {
    return this.value;
  }
  save(settings: HostSettings): void {
    this.value = settings;
  }
  patchCookies(cookies: Partial<HostSettings['cookies']>): void {
    this.value = { ...this.value, cookies: { ...this.value.cookies, ...cookies } };
  }
}

class NullConversationQueries implements ConversationQueries {
  list(): Page<ConversationSummaryDto> {
    return { items: [], nextCursor: null };
  }
  get(): ConversationDetailDto | null {
    return null;
  }
  recentEvents(): ConversationEventDto[] {
    return [];
  }
}

const directTransactions: TransactionRunner = { transaction: (work) => work() };

export class InMemoryPersistence implements PersistenceContext {
  readonly downloads = new InMemoryDownloads();
  readonly batches = new InMemoryBatches();
  readonly files = new InMemoryFiles();
  readonly events = new InMemoryEvents();
  readonly folders = new InMemoryFolders();
  readonly settings = new InMemorySettings();
  readonly conversations: ConversationQueries = new NullConversationQueries();
  readonly tx: TransactionRunner = directTransactions;
  close(): void {}
}

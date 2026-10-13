/** Wires every A2 fake together so each test only states what differs. */
import type { FolderDto } from '../../../shared/contracts/dto.ts';
import type { DownloadRecord, HostSettings } from '../ports/persistence.ts';
import { SettingsStore } from '../settings/settings-store.ts';
import { FakeDownloadsFacade, FakeRuntimeStatus } from './fake-downloads.ts';
import { FakeFileSystem, FakeLibraryScanner, FakePathSandbox } from './fake-files.ts';
import { FakeCookieVault, FakeCredentialVault } from './fake-secrets.ts';
import {
  CountingTransactionRunner,
  FakeConversationQueries,
  InMemoryDownloadRepository,
  InMemoryEventRepository,
  InMemoryFolderRepository,
  InMemoryMediaFileRepository,
  InMemorySettingsRepository
} from './in-memory-persistence.ts';
import { makeSettings } from './records.ts';
import { FixedClock, RecordingEventSink, StateNotifierSpy } from './recording-event-sink.ts';

export interface WorldOptions {
  readonly records?: readonly DownloadRecord[];
  readonly folders?: readonly FolderDto[];
  readonly settings?: Partial<HostSettings>;
  readonly cookies?: readonly string[];
  readonly downloadDir?: string;
  readonly caseInsensitiveFs?: boolean;
}

export function createWorld(options: WorldOptions = {}) {
  const records = new InMemoryDownloadRepository(options.records);
  const settingsRepository = new InMemorySettingsRepository(makeSettings(options.settings));
  const fs = new FakeFileSystem({ caseInsensitive: options.caseInsensitiveFs ?? false });
  return {
    records,
    files: new InMemoryMediaFileRepository(),
    events: new InMemoryEventRepository(),
    folders: new InMemoryFolderRepository(records, options.folders),
    queries: new FakeConversationQueries(),
    settingsRepository,
    settings: new SettingsStore(settingsRepository),
    tx: new CountingTransactionRunner(),
    fs,
    sandbox: new FakePathSandbox(fs, options.downloadDir ?? '/dl'),
    scanner: new FakeLibraryScanner(),
    cookieVault: new FakeCookieVault(options.cookies),
    credentials: new FakeCredentialVault(),
    downloads: new FakeDownloadsFacade(),
    runtime: new FakeRuntimeStatus(),
    sink: new RecordingEventSink(),
    state: new StateNotifierSpy(),
    clock: new FixedClock()
  };
}

export type World = ReturnType<typeof createWorld>;

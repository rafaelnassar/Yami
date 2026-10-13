/**
 * Composition root of the host: builds infrastructure and services from the
 * `system.configure` payload, runs one-time start-up work and owns shutdown.
 */
import { AppError, ErrorCode } from '../../shared/kernel/errors.ts';
import { systemClock } from '../../shared/kernel/clock.ts';
import type { CommandPayload } from '../../shared/contracts/host-protocol.ts';
import type { EventSink } from '../application/ports/system.ts';
import { NoticeCenter } from '../application/session/notice-center.ts';
import { RecentLogs } from '../application/session/recent-logs.ts';
import type { StatePublisher } from '../application/session/state-publisher.ts';
import { SettingsStore } from '../application/settings/settings-store.ts';
import { AccountsStatus } from '../application/accounts/accounts-status.ts';
import type { FileLogger } from '../infrastructure/logging/file-logger.ts';
import { LegacyImporter, legacyImportMarkerPath } from '../infrastructure/legacy/legacy-importer.ts';
import type { HostServices } from '../interface/handler-table.ts';
import { createInfrastructure, type ConfigurePayload, type HostInfrastructure } from './infrastructure.ts';
import { wireServices, type WiredServices } from './services.ts';
import { databaseRecoveryNotice, legacyImportDeferredNotice, legacyImportNotices } from './startup-notices.ts';

export { hostPlatform, type ConfigurePayload } from './infrastructure.ts';

export type ShutdownMode = CommandPayload<'lifecycle.shutdown'>['mode'];

export interface HostContainer {
  readonly services: HostServices;
  readonly logger: FileLogger;
  readonly statePublisher: StatePublisher;
  /** One-time start-up work: legacy import, download dir, re-attach downloads, probe tools. */
  start(): Promise<void>;
  /** Stops downloads per `mode`, cancels background work and closes resources. */
  shutdown(mode: ShutdownMode): Promise<void>;
}

async function resolveDownloadDir(infra: HostInfrastructure, preferred: string | null): Promise<string> {
  let lastReason: string = 'protected';
  for (const candidate of [preferred, infra.config.defaultDownloadDir]) {
    if (!candidate) continue;
    const validated = await infra.sandbox.validateDownloadDir(candidate);
    if (validated.ok) return validated.value;
    const reason = validated.error.params?.['reason'];
    if (typeof reason === 'string') lastReason = reason;
    infra.logger.warn('download dir rejected', {
      dir: candidate,
      code: validated.error.code,
      reason
    });
  }
  throw new AppError(ErrorCode.DOWNLOAD_DIR_FORBIDDEN, { reason: lastReason });
}

async function importLegacyData(infra: HostInfrastructure, events: EventSink): Promise<void> {
  const legacyDir = infra.config.paths.legacyDir;
  if (!legacyDir) return;
  const importer = new LegacyImporter({
    target: infra.persistence.context,
    cookies: infra.cookieVault,
    credentials: infra.credentialVault,
    logger: infra.logger,
    clock: systemClock,
    legacyDir,
    workDir: infra.config.paths.tempDir,
    // Survives a database recreated after corruption, so the import never runs twice.
    markerFile: legacyImportMarkerPath(infra.config.paths.dataDir),
    validateDownloadDir: (dir) => infra.sandbox.validateDownloadDir(dir)
  });
  if (infra.vault.state !== 'ready') {
    // Deferred (no marker is written): its secrets could not be migrated into the vault and
    // the plaintext cleanup must not run; it runs on the first start with a working vault.
    if (await importer.pending()) {
      infra.logger.warn('legacy import deferred: the secret vault is disabled');
      events.publish({ type: 'notice', notice: legacyImportDeferredNotice(legacyDir, systemClock.now()) });
    }
    return;
  }
  const report = await importer.run();
  infra.logger.info('legacy import', { ...report });
  for (const notice of legacyImportNotices(report, legacyDir, systemClock.now())) {
    events.publish({ type: 'notice', notice });
  }
}

export async function createHostContainer(config: ConfigurePayload, transportSink: EventSink): Promise<HostContainer> {
  const infra = createInfrastructure(config);
  // Event sink chain: services → RecentLogs → NoticeCenter → dispatcher (throttling) → main.
  const notices = new NoticeCenter(transportSink);
  const events = new RecentLogs(notices);
  const settings = new SettingsStore(infra.persistence.context.settings);
  const accounts = new AccountsStatus(infra.credentialVault);
  let wired: WiredServices | null = null;

  const requireWired = (): WiredServices => {
    if (!wired) throw new AppError(ErrorCode.HOST_UNAVAILABLE);
    return wired;
  };

  const start = async (): Promise<void> => {
    await infra.workspace.initialize();
    if (infra.persistence.recovered) {
      const { backupPath, salvage } = infra.persistence;
      infra.logger.warn('database was corrupt and has been recreated', {
        backup: backupPath,
        salvagedRows: salvage?.copied ?? 0,
        truncated: salvage?.truncated ?? false
      });
      events.publish({ type: 'notice', notice: databaseRecoveryNotice(backupPath, salvage, systemClock.now()) });
    }
    await importLegacyData(infra, events);
    infra.sandbox.setDownloadDir(await resolveDownloadDir(infra, settings.read().downloadDir));
    // Services are wired after the import so every cache starts from the imported settings.
    const ready = wireServices({ infra, events, notices, accounts, settings });
    wired = ready;
    await accounts.refresh();
    await ready.runtime.refresh();
    await ready.coordinator.initialize();
    ready.runtime.autoInstallMissing();
  };

  const shutdown = async (mode: ShutdownMode): Promise<void> => {
    const current = wired;
    try {
      if (current) await current.coordinator.shutdown(mode);
    } finally {
      if (current) await current.runtime.dispose();
      infra.persistence.context.close();
      infra.logger.info('host stopped', { mode });
      infra.logger.flushSync();
    }
  };

  return {
    get services(): HostServices {
      return requireWired().services;
    },
    get statePublisher(): StatePublisher {
      return requireWired().statePublisher;
    },
    logger: infra.logger,
    start,
    shutdown
  };
}

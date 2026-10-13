/**
 * Notices published once at start-up about the database recovery and the
 * legacy (1.x) import, built from the infrastructure reports. Codes and params
 * match `notices.<code>.*` in src/shared/i18n/messages/notices.ts.
 */
import type { NoticeDto } from '../../shared/contracts/dto.ts';
import { LEGACY_IMPORT_MAX_ATTEMPTS, type LegacyImportReport } from '../infrastructure/legacy/legacy-importer.ts';
import type { SalvageReport } from '../infrastructure/persistence/database-salvage.ts';

function notice(id: string, kind: NoticeDto['kind'], code: string, params: NoticeDto['params'], ts: number): NoticeDto {
  return { id, kind, code, params, action: null, ts };
}

/** How much of the corrupted database made it into the recreated one. */
export function databaseRecoveryNotice(
  backupPath: string | null,
  salvage: SalvageReport | null,
  now: number
): NoticeDto {
  const params = {
    backupPath,
    conversations: salvage?.tables['downloads']?.copied ?? 0,
    files: salvage?.tables['media_files']?.copied ?? 0
  };
  const code = (salvage?.copied ?? 0) > 0 ? 'databaseRecovered' : 'databaseRecoveredEmpty';
  return notice('database-recovered', 'warn', code, params, now);
}

/** The legacy import waits for the secrets vault (it would migrate and delete plaintext secrets). */
export function legacyImportDeferredNotice(legacyDir: string, now: number): NoticeDto {
  return notice('legacy-import-deferred', 'warn', 'legacyImportDeferred', { legacyDir }, now);
}

export function legacyImportNotices(report: LegacyImportReport, legacyDir: string, now: number): NoticeDto[] {
  const notices: NoticeDto[] = [];
  const { plaintextSecretsRemoved: removed, plaintextSecretsKept: kept, failedSteps } = report;
  if (removed > 0) {
    notices.push(notice('legacy-secrets-removed', 'info', 'legacySecretsRemoved', { count: removed, legacyDir }, now));
  }
  if (kept > 0) {
    notices.push(notice('legacy-secrets-kept', 'warn', 'legacySecretsKept', { count: kept, legacyDir }, now));
  }
  if (failedSteps.length > 0) {
    const steps = failedSteps.join(', ');
    // `failedAttempts` is 0 only when a non-history step failed while the secrets were deferred.
    const attempt = Math.max(1, report.failedAttempts);
    notices.push(
      report.status === 'incomplete'
        ? notice(
            'legacy-import-retry',
            'warn',
            'legacyImportRetry',
            { steps, attempt, maxAttempts: LEGACY_IMPORT_MAX_ATTEMPTS },
            now
          )
        : notice('legacy-import-failed', 'warn', 'legacyImportFailed', { steps, legacyDir }, now)
    );
  }
  return notices;
}

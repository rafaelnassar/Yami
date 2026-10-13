import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NoticeDto } from '../../shared/contracts/dto.ts';
import { translatorFor } from '../../shared/i18n/catalog.ts';
import type { LegacyImportReport } from '../infrastructure/legacy/legacy-importer.ts';
import type { SalvageReport } from '../infrastructure/persistence/database-salvage.ts';
import { databaseRecoveryNotice, legacyImportDeferredNotice, legacyImportNotices } from './startup-notices.ts';

const REPORT: LegacyImportReport = {
  status: 'imported',
  conversations: 4,
  pausedDownloads: 0,
  batches: 1,
  files: 2,
  events: 3,
  skipped: 0,
  cookies: { imported: 2, existing: 0, invalid: 0 },
  pixivImported: true,
  settingsImported: true,
  plaintextSecretsRemoved: 0,
  plaintextSecretsKept: 0,
  failedSteps: [],
  failedAttempts: 0
};

const SALVAGE: SalvageReport = {
  opened: true,
  tables: {
    downloads: { copied: 12, skipped: 1, unreadable: true },
    media_files: { copied: 30, skipped: 2, unreadable: false }
  },
  copied: 42,
  skipped: 3,
  truncated: false
};

/** Every notice must have a title and a fully interpolated message in each language. */
function assertRenders(notice: NoticeDto): void {
  for (const locale of ['pt', 'en', 'es'] as const) {
    const t = translatorFor(locale);
    for (const part of ['title', 'message']) {
      const key = `notices.${notice.code}.${part}`;
      assert.ok(t.has(key), `${locale}: missing ${key}`);
      const text = t.tDynamic(key, notice.params);
      assert.doesNotMatch(text, /\{\w+\}/, `${locale}: ${key} has an unfilled placeholder: ${text}`);
    }
  }
}

describe('start-up notices', () => {
  it('reports how much of a corrupted database was recovered', () => {
    const recovered = databaseRecoveryNotice('/data/yami.db.corrupt-1', SALVAGE, 5);
    assert.deepEqual(recovered, {
      id: 'database-recovered',
      kind: 'warn',
      code: 'databaseRecovered',
      params: { backupPath: '/data/yami.db.corrupt-1', conversations: 12, files: 30 },
      action: null,
      ts: 5
    });
    assertRenders(recovered);
    assert.match(translatorFor('en').tDynamic('notices.databaseRecovered.message', recovered.params), /12 download/);

    const nothing = { ...SALVAGE, tables: {}, copied: 0, opened: false };
    for (const salvage of [nothing, null]) {
      const empty = databaseRecoveryNotice('/data/yami.db.corrupt-1', salvage, 5);
      assert.equal(empty.code, 'databaseRecoveredEmpty');
      assertRenders(empty);
    }
  });

  it('announces an import postponed until the vault works', () => {
    const deferred = legacyImportDeferredNotice('/home/u/.yami', 3);
    assert.deepEqual(
      [deferred.id, deferred.kind, deferred.code, deferred.params],
      ['legacy-import-deferred', 'warn', 'legacyImportDeferred', { legacyDir: '/home/u/.yami' }]
    );
    assertRenders(deferred);
  });

  it('publishes nothing for a clean import', () => {
    assert.deepEqual(legacyImportNotices(REPORT, '/home/u/.yami', 1), []);
  });

  it('tells the user which plaintext secrets were removed and which were kept', () => {
    const notices = legacyImportNotices(
      { ...REPORT, plaintextSecretsRemoved: 3, plaintextSecretsKept: 1 },
      '/home/u/.yami',
      1
    );
    assert.deepEqual(
      notices.map((n) => [n.id, n.kind, n.code, n.params]),
      [
        ['legacy-secrets-removed', 'info', 'legacySecretsRemoved', { count: 3, legacyDir: '/home/u/.yami' }],
        ['legacy-secrets-kept', 'warn', 'legacySecretsKept', { count: 1, legacyDir: '/home/u/.yami' }]
      ]
    );
    notices.forEach(assertRenders);
  });

  it('announces a retry while the import is incomplete and a final failure otherwise', () => {
    const [retry] = legacyImportNotices(
      { ...REPORT, status: 'incomplete', failedSteps: ['database'], failedAttempts: 2 },
      '/home/u/.yami',
      1
    );
    assert.equal(retry?.code, 'legacyImportRetry');
    assert.deepEqual(retry?.params, { steps: 'database', attempt: 2, maxAttempts: 3 });
    if (retry) assertRenders(retry);

    const [failed] = legacyImportNotices(
      { ...REPORT, failedSteps: ['database', 'downloads'], failedAttempts: 3 },
      '/home/u/.yami',
      1
    );
    assert.equal(failed?.code, 'legacyImportFailed');
    assert.deepEqual(failed?.params, { steps: 'database, downloads', legacyDir: '/home/u/.yami' });
    if (failed) assertRenders(failed);
  });
});

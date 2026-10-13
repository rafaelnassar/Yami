import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BatchFinishedDto, DownloadFinishedDto } from '../../../shared/contracts/dto.ts';
import { translatorFor } from '../../../shared/i18n/catalog.ts';
import { batchNotification, downloadNotification } from './notification-text.ts';

const download = (overrides: Partial<DownloadFinishedDto> = {}): DownloadFinishedDto => ({
  conversationId: 'c1',
  batchId: null,
  sourceUrl: 'https://www.pixiv.net/artworks/1?token=secret',
  title: 'Artwork',
  engine: 'gallery-dl',
  status: 'completed',
  outcome: { kind: 'ok', reason: null, detail: null },
  counters: { done: 3, skipped: 1, errors: 0 },
  completedAt: 1,
  ...overrides
});

describe('download notifications', () => {
  it('summarizes a completed download without leaking the URL query', () => {
    const content = downloadNotification(download(), translatorFor('pt'));
    assert.equal(content.title, 'Download concluído · pixiv.net');
    assert.equal(content.body, '3 arquivos · 1 já existia · gallery-dl');
    assert.equal(content.silent, true);
    assert.equal(content.urgency, 'low');
    assert.equal(content.key, 'download:c1:completed');
    assert.ok(!content.body.includes('secret'));
  });

  it('uses singular/plural forms and the "nothing new" case', () => {
    const t = translatorFor('en');
    assert.equal(
      downloadNotification(download({ counters: { done: 1, skipped: 0, errors: 0 } }), t).body,
      '1 file · gallery-dl'
    );
    assert.equal(
      downloadNotification(download({ counters: { done: 0, skipped: 0, errors: 0 } }), t).body,
      'Nothing new to download · gallery-dl'
    );
  });

  it('flags a partial download (errors, or an engine that died mid-run) instead of "finished"', () => {
    const t = translatorFor('pt');
    const interrupted = downloadNotification(
      download({
        outcome: { kind: 'partial', reason: 'exit-code', detail: 'exit 1' },
        counters: { done: 50, skipped: 0, errors: 0 }
      }),
      t
    );
    assert.equal(interrupted.title, 'Download concluído com erros · pixiv.net');
    assert.equal(interrupted.body, '50 arquivos · interrompido antes do fim · gallery-dl');
    assert.equal(interrupted.silent, false);
    assert.equal(interrupted.urgency, 'normal');
    const withErrors = downloadNotification(
      download({
        outcome: { kind: 'partial', reason: null, detail: null },
        counters: { done: 2, skipped: 0, errors: 1 }
      }),
      translatorFor('en')
    );
    assert.equal(withErrors.title, 'Download finished with errors · pixiv.net');
    assert.equal(withErrors.body, '2 files · 1 error · gallery-dl');
  });

  it('shows the shortened failure detail, or a fallback', () => {
    const t = translatorFor('en');
    const long = 'x'.repeat(200);
    const failed = downloadNotification(
      download({ status: 'failed', engine: 'yt-dlp', outcome: { kind: 'error', reason: null, detail: long } }),
      t
    );
    assert.equal(failed.title, 'Download failed · pixiv.net');
    assert.equal(failed.urgency, 'critical');
    assert.ok(failed.body.startsWith(`${'x'.repeat(95)}…`));
    assert.ok(failed.body.endsWith(' · yt-dlp'));
    const fallback = downloadNotification(
      download({ status: 'failed', outcome: { kind: 'error', reason: null, detail: null } }),
      t
    );
    assert.equal(fallback.body, 'See the details in the app · gallery-dl');
  });
});

describe('batch notifications', () => {
  const batch = (overrides: Partial<BatchFinishedDto> = {}): BatchFinishedDto => ({
    batchId: 'b1',
    engine: 'gallery-dl',
    total: 5,
    completed: 5,
    failed: 0,
    cancelled: 0,
    ...overrides
  });

  it('picks the title by severity', () => {
    const t = translatorFor('es');
    assert.equal(batchNotification(batch(), t).title, 'Lote completado');
    assert.equal(batchNotification(batch({ completed: 4, cancelled: 1 }), t).title, 'Lote cancelado');
    const failed = batchNotification(batch({ completed: 3, failed: 1, cancelled: 1 }), t);
    assert.equal(failed.title, 'Lote con errores');
    assert.equal(failed.body, '3/5 completados · 1 con error · 1 cancelado · gallery-dl');
    assert.equal(failed.key, 'batch:b1:failed');
    assert.equal(failed.silent, false);
  });
});

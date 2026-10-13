import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { SqlitePersistence } from '../persistence/sqlite-persistence.ts';
import { captureLogger, makeTempDir, openTestPersistence } from '../persistence/test-fixtures.ts';
import {
  LEGACY_IMPORT_MARKER,
  LegacyImportProgress,
  legacyImportMarkerPath,
  readLegacyImportMarkerFile,
  writeLegacyImportMarkerFile
} from './legacy-import-progress.ts';

describe('legacy import progress', () => {
  let dir: string;
  let cleanup: () => void;
  let persistence: SqlitePersistence;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir('yami-legacy-progress-'));
    persistence = openTestPersistence(path.join(dir, 'data'));
  });
  afterEach(() => {
    persistence.context.close();
    cleanup();
  });

  it('reads the marker file tolerantly', async () => {
    const file = legacyImportMarkerPath(dir);
    assert.equal(await readLegacyImportMarkerFile(file), null);
    await writeLegacyImportMarkerFile(file, 42);
    assert.equal(await readLegacyImportMarkerFile(file), 42);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    for (const content of ['{"importedAt": -1}', '[]', 'x'.repeat(10_000)]) {
      writeFileSync(file, content);
      assert.equal(await readLegacyImportMarkerFile(file), 0, `present means imported: ${content.slice(0, 20)}`);
    }
  });

  it('counts failed attempts and records steps that must not repeat', () => {
    const progress = new LegacyImportProgress({
      markers: persistence.context.markers,
      markerFile: null,
      logger: captureLogger().logger
    });
    assert.equal(progress.failedAttempts, 0);
    assert.equal(progress.recordFailedAttempt(), 1);
    assert.equal(progress.recordFailedAttempt(), 2);
    assert.equal(progress.stepDone('settings'), false);
    progress.markStep('settings', 7);
    assert.equal(progress.stepDone('settings'), true);
    assert.equal(progress.stepDone('credentials'), false);
  });

  it('still finishes (database marker) when the marker file cannot be written', async () => {
    const blocker = path.join(dir, 'not-a-dir');
    writeFileSync(blocker, 'file');
    const { logger, entries } = captureLogger();
    const progress = new LegacyImportProgress({
      markers: persistence.context.markers,
      markerFile: path.join(blocker, 'legacy-import.json'),
      logger
    });
    await progress.finish(9);
    assert.equal(persistence.context.markers.get(LEGACY_IMPORT_MARKER), 9);
    assert.ok(entries.some((entry) => entry.message === 'legacy import marker file not written'));
    assert.equal(await progress.isFinished(), true);
  });
});

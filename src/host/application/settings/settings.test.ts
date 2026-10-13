import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { createWorld } from '../testing-a2/world.ts';
import { SetDefaultEngineService } from './set-default-engine.ts';
import { SetDownloadDirService } from './set-download-dir.ts';

describe('SetDefaultEngineService', () => {
  it('persists a new engine and republishes state', () => {
    const world = createWorld();
    const service = new SetDefaultEngineService(world.settings, world.state);
    assert.deepEqual(service.setDefaultEngine({ engine: 'yt-dlp' }), { ok: true, value: { engine: 'yt-dlp' } });
    assert.equal(world.settingsRepository.current.defaultEngine, 'yt-dlp');
    assert.equal(world.state.calls, 1);
  });

  it('does not write when the engine is unchanged', () => {
    const world = createWorld();
    new SetDefaultEngineService(world.settings, world.state).setDefaultEngine({ engine: 'gallery-dl' });
    assert.equal(world.settingsRepository.saves, 0);
    assert.equal(world.state.calls, 0);
  });
});

describe('SetDownloadDirService', () => {
  function setup() {
    const world = createWorld();
    const service = new SetDownloadDirService({
      sandbox: world.sandbox,
      settings: world.settings,
      scanner: world.scanner,
      events: world.sink,
      state: world.state
    });
    return { world, service };
  }

  it('applies the canonical directory everywhere', async () => {
    const { world, service } = setup();
    const result = await service.setDownloadDir({ path: '/media/ana/Yami/' });
    assert.deepEqual(result, { ok: true, value: { downloadDir: '/media/ana/Yami' } });
    assert.equal(world.sandbox.downloadDir, '/media/ana/Yami');
    assert.equal(world.settingsRepository.current.downloadDir, '/media/ana/Yami');
    assert.equal(world.scanner.invalidations, 1);
    assert.deepEqual(world.sink.types(), []);
    assert.equal(world.state.calls, 1);
  });

  it('changes nothing when the sandbox rejects the directory', async () => {
    const { world, service } = setup();
    world.sandbox.forbiddenDownloadDirs.add('/usr');
    const result = await service.setDownloadDir({ path: '/usr' });
    assert.ok(!result.ok);
    assert.equal(result.error.code, ErrorCode.DOWNLOAD_DIR_FORBIDDEN);
    assert.equal(world.sandbox.downloadDir, '/dl');
    assert.equal(world.settingsRepository.saves, 0);
    assert.equal(world.scanner.invalidations, 0);
    assert.equal(world.sink.events.length, 0);
  });
});

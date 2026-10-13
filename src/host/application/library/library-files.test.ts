import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { createWorld, type World } from '../testing-a2/world.ts';
import { DeleteFilesService } from './delete-files.ts';
import { InspectFileService } from './inspect-file.ts';
import { SandboxedFileRemover } from './sandboxed-file-remover.ts';

function stored(world: World, conversationId: string, path: string): void {
  world.files.add({
    conversationId,
    path,
    name: 'x',
    mediaType: 'image',
    extension: '.jpg',
    sizeBytes: 1,
    createdAt: 1
  });
}

describe('DeleteFilesService', () => {
  function setup() {
    const world = createWorld();
    const service = new DeleteFilesService({
      remover: new SandboxedFileRemover(world.sandbox, world.fs),
      files: world.files,
      scanner: world.scanner,
      events: world.sink
    });
    return { world, service };
  }

  it('reports per-path results for a batch with partial failures', async () => {
    const { world, service } = setup();
    world.fs.addFile('/dl/a.jpg').addFile('/dl/locked.jpg').addDir('/dl/folder');
    world.fs.removeFailures.set('/dl/locked.jpg', appError(ErrorCode.FILE_OPERATION_FAILED));
    stored(world, 'c1', '/dl/a.jpg');
    stored(world, 'c2', '/dl/gone.jpg');
    stored(world, 'c3', '/dl/locked.jpg');

    const paths = ['/dl/a.jpg', '/dl/a.jpg', '/dl/gone.jpg', '/dl/locked.jpg', '/etc/passwd', '/dl/folder'];
    const result = await service.delete({ paths });
    assert.ok(result.ok);
    assert.deepEqual(result.value.deleted, ['/dl/a.jpg', '/dl/gone.jpg']);
    assert.deepEqual(
      result.value.failed.map((failure) => [failure.path, failure.error.code]),
      [
        ['/dl/locked.jpg', ErrorCode.FILE_OPERATION_FAILED],
        ['/etc/passwd', ErrorCode.PATH_OUTSIDE_SANDBOX],
        ['/dl/folder', ErrorCode.PATH_INVALID]
      ]
    );
    assert.deepEqual(
      world.files.rows.map((row) => row.path),
      ['/dl/locked.jpg']
    );
    assert.equal(world.scanner.invalidations, 1);
    assert.deepEqual(world.sink.events, [
      { type: 'conversation.changed', conversationId: 'c1', reason: 'updated' },
      { type: 'conversation.changed', conversationId: 'c2', reason: 'updated' }
    ]);
  });

  it('removes rows stored under the canonical path too (symlinked download dir)', async () => {
    const { world, service } = setup();
    world.sandbox.aliases.set('/dl/link/a.jpg', '/dl/real/a.jpg');
    world.fs.addFile('/dl/real/a.jpg');
    stored(world, 'c1', '/dl/real/a.jpg');
    const result = await service.delete({ paths: ['/dl/link/a.jpg'] });
    assert.ok(result.ok && result.value.deleted.length === 1);
    assert.equal(world.files.rows.length, 0);
  });

  it('publishes nothing when every path failed', async () => {
    const { world, service } = setup();
    const result = await service.delete({ paths: ['/outside/a.jpg'] });
    assert.ok(result.ok && result.value.failed.length === 1);
    assert.equal(world.sink.events.length, 0);
    assert.equal(world.scanner.invalidations, 0);
  });
});

describe('InspectFileService', () => {
  function setup() {
    const world = createWorld();
    return { world, service: new InspectFileService(world.sandbox, world.fs) };
  }

  it('describes an existing media file', async () => {
    const { world, service } = setup();
    world.fs.addFile('/dl/v/clip.MP4', 1234);
    const result = await service.inspect({ path: '/dl/v/clip.MP4' });
    assert.deepEqual(result, {
      ok: true,
      value: {
        path: '/dl/v/clip.MP4',
        name: 'clip.MP4',
        exists: true,
        isDirectory: false,
        sizeBytes: 1234,
        mediaType: 'video',
        previewMime: 'video/mp4',
        risk: 'safe'
      }
    });
  });

  it('describes missing files, directories and dangerous types', async () => {
    const { world, service } = setup();
    world.fs.addDir('/dl/album.exe').addFile('/dl/setup.exe');
    const missing = await service.inspect({ path: '/dl/nope.png' });
    assert.ok(
      missing.ok && !missing.value.exists && missing.value.previewMime === null && missing.value.sizeBytes === null
    );
    const dir = await service.inspect({ path: '/dl/album.exe' });
    assert.ok(dir.ok && dir.value.isDirectory && dir.value.risk === 'safe' && dir.value.mediaType === 'other');
    const exe = await service.inspect({ path: '/dl/setup.exe' });
    assert.ok(exe.ok && exe.value.risk === 'blocked' && exe.value.previewMime === null);
  });

  it('blocks directories the OS would launch (macOS bundles, Windows CLSID junctions)', async () => {
    const { world, service } = setup();
    world.fs
      .addDir('/dl/Evil.app')
      .addDir('/dl/Setup.PKG')
      .addDir('/dl/Tools.{21EC2020-3AEA-1069-A2DD-08002B30309D}')
      .addDir('/dl/real.app');
    for (const path of ['/dl/Evil.app', '/dl/Setup.PKG', '/dl/Tools.{21EC2020-3AEA-1069-A2DD-08002B30309D}']) {
      const result = await service.inspect({ path });
      assert.ok(result.ok && result.value.isDirectory && result.value.risk === 'blocked', path);
    }
    // The canonical name decides: an innocent-looking symlink to a bundle is blocked too.
    world.sandbox.aliases.set('/dl/photos', '/dl/real.app');
    const aliased = await service.inspect({ path: '/dl/photos' });
    assert.ok(aliased.ok && aliased.value.name === 'real.app' && aliased.value.risk === 'blocked');
  });

  it('returns the canonical path and propagates sandbox rejections', async () => {
    const { world, service } = setup();
    world.sandbox.aliases.set('/dl/link.jpg', '/dl/real.jpg');
    world.fs.addFile('/dl/real.jpg');
    const aliased = await service.inspect({ path: '/dl/link.jpg' });
    assert.ok(aliased.ok && aliased.value.path === '/dl/real.jpg');
    const outside = await service.inspect({ path: '/home/ana/.ssh/id_rsa' });
    assert.ok(!outside.ok && outside.error.code === ErrorCode.PATH_OUTSIDE_SANDBOX);
  });
});

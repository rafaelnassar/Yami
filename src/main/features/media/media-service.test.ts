import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { FileInspectionDto } from '../../../shared/contracts/dto.ts';
import { ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { err, ok } from '../../../shared/kernel/result.ts';
import { nullLogger } from '../../infrastructure/logger.ts';
import { MediaRegistry } from './media-registry.ts';
import { MediaService } from './media-service.ts';
import { ThumbnailCache } from './thumbnail-cache.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'yami-media-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function file(overrides: Partial<FileInspectionDto> = {}): FileInspectionDto {
  return {
    path: '/dl/pic.jpg',
    name: 'pic.jpg',
    exists: true,
    isDirectory: false,
    sizeBytes: 100,
    mediaType: 'image',
    previewMime: 'image/jpeg',
    risk: 'safe',
    ...overrides
  };
}

function setup(inspected: FileInspectionDto, cacheDir = path.join(dir, 'cache'), exists = true) {
  let renders = 0;
  const registry = new MediaRegistry({ now: () => 0 });
  const service = new MediaService({
    inspect: async () => ok(inspected),
    registry,
    identify: async (file) => (exists ? { realPath: file, dev: 1n, ino: 2n, size: 100, mtimeNs: 1n } : null),
    statFile: async () => ({ mtimeMs: 1, size: 100 }),
    cache: new ThumbnailCache({ dir: cacheDir, logger: nullLogger }),
    renderer: {
      render: async () => {
        renders += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Uint8Array([137, 80, 78, 71]);
      }
    },
    logger: nullLogger
  });
  return { service, registry, renders: () => renders };
}

describe('MediaService', () => {
  it('issues a yami-media URL for previewable files only', async () => {
    const { service, registry } = setup(file());
    const result = await service.preview('/dl/pic.jpg');
    assert.ok(result.ok);
    assert.match(result.value.url, /^yami-media:\/\/m\/[a-f0-9]{32}$/);
    assert.equal(result.value.mime, 'image/jpeg');
    const token = result.value.url.split('/').pop() ?? '';
    assert.equal(registry.resolve(token)?.path, '/dl/pic.jpg');
    assert.equal(registry.resolve(token)?.identity.realPath, '/dl/pic.jpg');
    assert.equal(result.value.sizeBytes, 100);

    const doc = await setup(file({ name: 'a.pdf', previewMime: null, mediaType: 'document' })).service.preview(
      '/dl/a.pdf'
    );
    assert.equal(!doc.ok && doc.error.code, 'NOT_SUPPORTED');
    const gone = await setup(file({ exists: false })).service.preview('/dl/pic.jpg');
    assert.equal(!gone.ok && gone.error.code, 'PATH_NOT_FOUND');
    // Vanished (or stopped being a regular file) between the host check and registration.
    const raced = await setup(file(), path.join(dir, 'cache'), false).service.preview('/dl/pic.jpg');
    assert.equal(!raced.ok && raced.error.code, 'PATH_NOT_FOUND');
  });

  it('renders each thumbnail once (single-flight) and serves it from the cache after', async () => {
    const cacheDir = path.join(dir, 'thumbs');
    const { service, renders } = setup(file(), cacheDir);
    const [a, b] = await Promise.all([
      service.thumbnail('/dl/pic.jpg', 'small'),
      service.thumbnail('/dl/pic.jpg', 'small')
    ]);
    assert.ok(a.ok && b.ok);
    assert.equal(a.value.mime, 'image/png');
    assert.equal(renders(), 1);
    await service.thumbnail('/dl/pic.jpg', 'small');
    assert.equal(renders(), 1);
    await service.thumbnail('/dl/pic.jpg', 'large');
    assert.equal(renders(), 2);
    assert.equal(readdirSync(cacheDir).filter((name) => name.endsWith('.png')).length, 2);
  });

  it('validates again when the download folder changed while a URL was being issued', async () => {
    const registry = new MediaRegistry({ now: () => 0 });
    let inspections = 0;
    const service = new MediaService({
      inspect: async (target) => {
        inspections += 1;
        // The host answers for the old folder, then main revokes every token (folder changed).
        if (inspections % 2 === 1) {
          registry.clear();
          return ok(file({ path: target }));
        }
        return err(appError(ErrorCode.PATH_OUTSIDE_SANDBOX));
      },
      registry,
      identify: async (target) => ({ realPath: target, dev: 1n, ino: 2n, size: 100, mtimeNs: 1n }),
      statFile: async () => ({ mtimeMs: 1, size: 100 }),
      cache: new ThumbnailCache({ dir: path.join(dir, 'generation'), logger: nullLogger }),
      renderer: { render: async () => new Uint8Array([137, 80, 78, 71]) },
      logger: nullLogger
    });
    const preview = await service.preview('/old/pic.jpg');
    assert.equal(!preview.ok && preview.error.code, 'PATH_OUTSIDE_SANDBOX');
    const thumbnail = await service.thumbnail('/old/pic.jpg', 'small');
    assert.equal(!thumbnail.ok && thumbnail.error.code, 'PATH_OUTSIDE_SANDBOX');
    assert.equal(inspections, 4);
  });

  it('refuses thumbnails for audio', async () => {
    const result = await setup(
      file({ name: 'a.mp3', mediaType: 'audio', previewMime: 'audio/mpeg' })
    ).service.thumbnail('/dl/a.mp3', 'small');
    assert.equal(!result.ok && result.error.code, 'NOT_SUPPORTED');
  });
});

describe('ThumbnailCache', () => {
  it('evicts least recently used files beyond the size cap', async () => {
    let now = 0;
    const cacheDir = path.join(dir, 'lru');
    const cache = new ThumbnailCache({ dir: cacheDir, maxBytes: 25, now: () => now, logger: nullLogger });
    const key = (n: number): string =>
      String(n)
        .repeat(40)
        .slice(0, 40)
        .replace(/[^a-f0-9]/g, 'a');
    for (const n of [1, 2, 3]) {
      now += 1;
      await cache.put(key(n), new Uint8Array(10));
    }
    assert.equal(await cache.get(key(1)), null);
    assert.ok(await cache.get(key(3)));
  });
});

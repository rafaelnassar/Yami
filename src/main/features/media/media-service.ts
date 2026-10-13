/**
 * `media:preview` and `media:thumbnail`: the host validates the path (`files.inspect`:
 * inside the download dir, previewable media only), then main issues a short-lived
 * `yami-media://` URL for the file or for its cached PNG thumbnail, bound to the file's
 * identity at that moment (see `media-identity.ts`).
 */
import type { FileInspectionDto } from '../../../shared/contracts/dto.ts';
import type { MediaUrlDto } from '../../../shared/contracts/ipc.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { describeError, type Logger } from '../../infrastructure/logger.ts';
import { mediaUrlFor } from './media-protocol.ts';
import type { MediaFileIdentity } from './media-identity.ts';
import type { MediaRegistry } from './media-registry.ts';
import { thumbnailKey, type ThumbnailCache } from './thumbnail-cache.ts';
import type { MediaType } from '../../../shared/domain/media.ts';

export type ThumbnailSize = 'small' | 'large';

/** Renders thumbnails (Electron `nativeImage` in production, see `thumbnail-renderer.ts`). */
export interface ThumbnailRenderer {
  /** PNG bytes whose longest edge is at most `maxEdge`, or `null` when unsupported. */
  render(filePath: string, mediaType: MediaType, maxEdge: number): Promise<Uint8Array | null>;
}

export const THUMBNAIL_EDGE: Readonly<Record<ThumbnailSize, number>> = { small: 320, large: 960 };

/** Folder changes racing one request (see `MediaService.#current`); more than this means something is wrong. */
const MAX_ISSUE_ATTEMPTS = 3;

export interface MediaServiceDeps {
  readonly inspect: (path: string) => Promise<Result<FileInspectionDto, AppErrorData>>;
  readonly registry: MediaRegistry;
  /** Resolves links and identifies the regular file (`MediaFileAccess.identify`). */
  readonly identify: (path: string) => Promise<MediaFileIdentity | null>;
  readonly statFile: (path: string) => Promise<{ readonly mtimeMs: number; readonly size: number } | null>;
  readonly cache: ThumbnailCache;
  readonly renderer: ThumbnailRenderer;
  readonly logger: Logger;
}

function requireFile(inspection: FileInspectionDto): Result<FileInspectionDto, AppErrorData> {
  if (!inspection.exists) return err(appError(ErrorCode.PATH_NOT_FOUND));
  if (inspection.isDirectory) return err(appError(ErrorCode.NOT_SUPPORTED));
  return ok(inspection);
}

export class MediaService {
  readonly #deps: MediaServiceDeps;
  readonly #inFlight = new Map<string, Promise<Result<MediaUrlDto, AppErrorData>>>();

  constructor(deps: MediaServiceDeps) {
    this.#deps = deps;
  }

  async preview(filePath: string): Promise<Result<MediaUrlDto, AppErrorData>> {
    return this.#current(() => this.#preview(filePath));
  }

  async thumbnail(filePath: string, size: ThumbnailSize): Promise<Result<MediaUrlDto, AppErrorData>> {
    return this.#current(() => this.#thumbnailFor(filePath, size));
  }

  /**
   * Runs `issue` again when the registry was cleared meanwhile (the download folder changed): the
   * host validated the file against the old folder, so its URL must not be handed out. The token
   * of the discarded run is never returned; a re-run that validates the same file may reuse it.
   */
  async #current(issue: () => Promise<Result<MediaUrlDto, AppErrorData>>): Promise<Result<MediaUrlDto, AppErrorData>> {
    for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
      const generation = this.#deps.registry.generation;
      const result = await issue();
      if (this.#deps.registry.generation === generation) return result;
    }
    return err(appError(ErrorCode.CANCELLED));
  }

  async #preview(filePath: string): Promise<Result<MediaUrlDto, AppErrorData>> {
    const inspected = await this.#inspect(filePath);
    if (!inspected.ok) return inspected;
    const file = inspected.value;
    if (!file.previewMime) return err(appError(ErrorCode.NOT_SUPPORTED));
    const identity = await this.#deps.identify(file.path);
    if (!identity) return err(appError(ErrorCode.PATH_NOT_FOUND));
    const token = this.#deps.registry.register({ path: file.path, mime: file.previewMime, name: file.name, identity });
    return ok({ url: mediaUrlFor(token), mime: file.previewMime, sizeBytes: identity.size, name: file.name });
  }

  async #thumbnailFor(filePath: string, size: ThumbnailSize): Promise<Result<MediaUrlDto, AppErrorData>> {
    const inspected = await this.#inspect(filePath);
    if (!inspected.ok) return inspected;
    const file = inspected.value;
    if (!file.previewMime || (file.mediaType !== 'image' && file.mediaType !== 'video')) {
      return err(appError(ErrorCode.NOT_SUPPORTED));
    }
    const info = await this.#deps.statFile(file.path);
    if (!info) return err(appError(ErrorCode.PATH_NOT_FOUND));
    const key = thumbnailKey(file.path, info.mtimeMs, info.size, size);

    const running = this.#inFlight.get(key);
    if (running) return running;
    const task = this.#thumbnail(file, key, THUMBNAIL_EDGE[size]).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, task);
    return task;
  }

  async #thumbnail(file: FileInspectionDto, key: string, edge: number): Promise<Result<MediaUrlDto, AppErrorData>> {
    let cached = await this.#deps.cache.get(key);
    if (!cached) {
      let png: Uint8Array | null = null;
      try {
        png = await this.#deps.renderer.render(file.path, file.mediaType, edge);
      } catch (error) {
        this.#deps.logger.debug('thumbnail render failed', describeError(error));
      }
      if (!png) return err(appError(ErrorCode.NOT_SUPPORTED));
      cached = await this.#deps.cache.put(key, png);
    }
    const identity = await this.#deps.identify(cached.path);
    if (!identity) return err(appError(ErrorCode.PATH_NOT_FOUND));
    const token = this.#deps.registry.register({ path: cached.path, mime: 'image/png', name: file.name, identity });
    return ok({ url: mediaUrlFor(token), mime: 'image/png', sizeBytes: identity.size, name: file.name });
  }

  async #inspect(filePath: string): Promise<Result<FileInspectionDto, AppErrorData>> {
    const result = await this.#deps.inspect(filePath);
    return result.ok ? requireFile(result.value) : result;
  }
}

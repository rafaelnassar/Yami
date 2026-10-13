/** `media:*` — short-lived `yami-media://` URLs for previews and thumbnails. */
import { IPC, IpcSchemas } from '../../../shared/contracts/ipc.ts';
import type { MediaService } from '../../features/media/media-service.ts';
import { parseArg, toIpcResult, type IpcRouter } from '../ipc-router.ts';

export function registerMediaController(router: IpcRouter, media: MediaService): void {
  router.handleResult(IPC.media.preview, async (_ctx, arg) => {
    const parsed = parseArg(IpcSchemas.filePath, arg);
    return toIpcResult(parsed.ok ? await media.preview(parsed.value.path) : parsed);
  });
  router.handleResult(IPC.media.thumbnail, async (_ctx, arg) => {
    const parsed = parseArg(IpcSchemas.thumbnail, arg);
    return toIpcResult(parsed.ok ? await media.thumbnail(parsed.value.path, parsed.value.size) : parsed);
  });
}

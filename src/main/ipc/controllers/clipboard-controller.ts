/** `clipboard:*` — explicit, user-initiated paste: only http(s) URLs leave main. */
import { LIMITS } from '../../../shared/contracts/host-protocol.ts';
import { IPC } from '../../../shared/contracts/ipc.ts';
import { extractHttpUrls } from '../../features/clipboard/clipboard-urls.ts';
import type { IpcRouter } from '../ipc-router.ts';

export function registerClipboardController(router: IpcRouter, readText: () => string): void {
  router.handleValue(IPC.clipboard.readUrls, (): readonly string[] =>
    extractHttpUrls(readText(), LIMITS.maxUrlsPerBatch)
  );
}

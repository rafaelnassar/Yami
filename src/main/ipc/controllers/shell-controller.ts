/** `shell:*` — open links/files with the OS (validated; files go through the host + risk policy). */
import { IPC, IpcSchemas } from '../../../shared/contracts/ipc.ts';
import type { ShellService } from '../../features/shell/shell-service.ts';
import { parseArg, toIpcResult, type IpcRouter } from '../ipc-router.ts';

export function registerShellController(router: IpcRouter, shell: ShellService): void {
  router.handleResult(IPC.shell.openExternal, async (_ctx, arg) => {
    const parsed = parseArg(IpcSchemas.openExternal, arg);
    return toIpcResult(parsed.ok ? await shell.openExternal(parsed.value.url) : parsed);
  });
  router.handleResult(IPC.shell.openFile, async (ctx, arg) => {
    const parsed = parseArg(IpcSchemas.filePath, arg);
    return toIpcResult(parsed.ok ? await shell.openFile(parsed.value.path, ctx.view) : parsed);
  });
  router.handleResult(IPC.shell.revealFile, async (_ctx, arg) => {
    const parsed = parseArg(IpcSchemas.filePath, arg);
    return toIpcResult(parsed.ok ? await shell.revealFile(parsed.value.path) : parsed);
  });
}

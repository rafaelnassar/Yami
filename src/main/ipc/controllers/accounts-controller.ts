/** `accounts:*` — site connect/disconnect and API-key paste (secrets stay out of host event payloads). */
import { isOAuthUiSiteId } from '../../../shared/domain/oauth-sites.ts';
import { IPC, IpcSchemas } from '../../../shared/contracts/ipc.ts';
import { ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { err } from '../../../shared/kernel/result.ts';
import type { OAuthAccounts } from '../../features/accounts/oauth-accounts.ts';
import { parseArg, toIpcResult, type IpcRouter } from '../ipc-router.ts';

export function registerAccountsController(router: IpcRouter, accounts: OAuthAccounts): void {
  router.handleResult(IPC.accounts.connect, async (_ctx, arg) => {
    const parsed = parseArg(IpcSchemas.oauthSiteRef, arg);
    if (!parsed.ok) return toIpcResult(parsed);
    const { siteId } = parsed.value;
    if (!isOAuthUiSiteId(siteId)) {
      return toIpcResult(err(appError(ErrorCode.VALIDATION_FAILED, { path: 'siteId' })));
    }
    return toIpcResult(await accounts.connect(siteId));
  });
  router.handleResult(IPC.accounts.disconnect, async (_ctx, arg) => {
    const parsed = parseArg(IpcSchemas.oauthSiteRef, arg);
    if (!parsed.ok) return toIpcResult(parsed);
    const { siteId } = parsed.value;
    if (!isOAuthUiSiteId(siteId)) {
      return toIpcResult(err(appError(ErrorCode.VALIDATION_FAILED, { path: 'siteId' })));
    }
    return toIpcResult(await accounts.disconnect(siteId));
  });
  router.handleResult(IPC.accounts.saveApiKey, async (_ctx, arg) => {
    const parsed = parseArg(IpcSchemas.saveApiKey, arg);
    if (!parsed.ok) return toIpcResult(parsed);
    const { siteId, credentials } = parsed.value;
    if (!isOAuthUiSiteId(siteId)) {
      return toIpcResult(err(appError(ErrorCode.VALIDATION_FAILED, { path: 'siteId' })));
    }
    return toIpcResult(await accounts.saveApiKey(siteId, credentials));
  });
  router.handleResult(IPC.accounts.connectPixiv, async () => toIpcResult(await accounts.connectPixiv()));
  router.handleResult(IPC.accounts.disconnectPixiv, async () => toIpcResult(await accounts.disconnectPixiv()));
}

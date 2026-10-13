/** Site accounts (OAuth in main; API-key sites paste credentials in this panel). */
import { useEffect, useState } from 'react';
import { AlertTriangle, Link2 } from 'lucide-react';
import type { AccountsDto } from '../../../shared/contracts/dto.ts';
import type { IpcResult } from '../../../shared/contracts/ipc.ts';
import { OAUTH_UI_SITES, vaultIdForUiSite, type OAuthUiSiteId } from '../../../shared/domain/oauth-sites.ts';
import { useHost, useServices } from '../../app/services-context.tsx';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { Button } from '../../shared/ui/button.tsx';
import { Input } from '../../shared/ui/input.tsx';
import { Spinner } from '../../shared/ui/spinner.tsx';
import { errorText, key } from '../notices/notices-store.ts';
import { SettingsBlock } from './SettingsBlock.tsx';

const CANCEL_CODES = new Set(['PIXIV_LOGIN_CANCELLED', 'OAUTH_LOGIN_CANCELLED']);

export function AccountsSection({ secretsProtected }: { secretsProtected: boolean | null }) {
  const t = useT();
  const { client, notices } = useServices();
  const hostAccounts = useHost((state) => state.state?.config.accounts ?? null);
  const vaultDisabled = useHost((state) => state.state?.config.vault.state === 'disabled');
  const [busySite, setBusySite] = useState<OAuthUiSiteId | null>(null);
  const [apiKeyPaste, setApiKeyPaste] = useState('');
  const [overrideVault, setOverrideVault] = useState<string | null>(null);
  const [overrideStatus, setOverrideStatus] = useState<{ connected: boolean; userName: string | null } | null>(null);

  useEffect(() => {
    setOverrideVault(null);
    setOverrideStatus(null);
  }, [hostAccounts]);

  const statusFor = (uiSiteId: OAuthUiSiteId): { connected: boolean; userName: string | null } => {
    const vaultId = vaultIdForUiSite(uiSiteId);
    if (overrideVault === vaultId && overrideStatus) return overrideStatus;
    if (!hostAccounts) return { connected: false, userName: null };
    return hostAccounts.sites[vaultId] ?? { connected: false, userName: null };
  };

  const applyResult = (uiSiteId: OAuthUiSiteId, connect: boolean, result: IpcResult<AccountsDto>): void => {
    const vaultId = vaultIdForUiSite(uiSiteId);
    const toast = notices.getState();
    if (!result.ok) {
      if (!CANCEL_CODES.has(result.error.code)) {
        toast.push({
          kind: 'error',
          title: key(connect ? 'ui.settings.accounts.connectFail' : 'ui.settings.accounts.disconnectFail'),
          message: errorText(result.error)
        });
      }
      return;
    }
    const siteStatus = result.data.sites[vaultId] ?? result.data.pixiv;
    setOverrideVault(vaultId);
    setOverrideStatus(siteStatus);
    if (connect) setApiKeyPaste('');
    toast.push(
      connect
        ? {
            kind: 'success',
            title: key('ui.settings.accounts.connectOk'),
            message: key('ui.settings.accounts.connectOkMsg', { site: t.t(`ui.settings.accounts.site.${uiSiteId}`) })
          }
        : {
            kind: 'success',
            title: key('ui.settings.accounts.disconnectOk'),
            message: key('ui.settings.accounts.disconnectOkMsg', {
              site: t.t(`ui.settings.accounts.site.${uiSiteId}`)
            })
          }
    );
  };

  const runOAuth = async (uiSiteId: OAuthUiSiteId, connect: boolean): Promise<void> => {
    setBusySite(uiSiteId);
    const result = await client.call((api) =>
      connect ? api.accounts.connect(uiSiteId) : api.accounts.disconnect(uiSiteId)
    );
    setBusySite(null);
    applyResult(uiSiteId, connect, result);
  };

  const saveApiKey = async (uiSiteId: OAuthUiSiteId): Promise<void> => {
    setBusySite(uiSiteId);
    const result = await client.call((api) => api.accounts.saveApiKey(uiSiteId, apiKeyPaste));
    setBusySite(null);
    applyResult(uiSiteId, true, result);
  };

  const disconnect = async (uiSiteId: OAuthUiSiteId): Promise<void> => {
    setBusySite(uiSiteId);
    const result = await client.call((api) => api.accounts.disconnect(uiSiteId));
    setBusySite(null);
    applyResult(uiSiteId, false, result);
  };

  return (
    <SettingsBlock title={t.t('ui.settings.accounts.title')} icon={Link2}>
      <p className="m-0 text-xs text-text-3">{t.t('ui.settings.accounts.description')}</p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {OAUTH_UI_SITES.map((site) => {
          const uiSiteId = site.id;
          const account = statusFor(uiSiteId);
          const connected = account.connected;
          const busy = busySite === uiSiteId;
          const unsupported = site.auth === 'unsupported';
          const apiKeyAuth = site.auth === 'api-key';
          const status = connected
            ? account.userName
              ? t.t('ui.settings.accounts.connectedAs', { name: account.userName })
              : t.t('ui.settings.accounts.connected')
            : t.t('ui.settings.accounts.disconnected');

          return (
            <li key={uiSiteId} className="flex flex-col gap-3 border-b border-border/60 pb-3 last:border-0 last:pb-0">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="m-0 text-sm font-medium text-text">{t.t(`ui.settings.accounts.site.${uiSiteId}`)}</p>
                  <p className="m-0 text-xs text-text-3">{t.t(`ui.settings.accounts.siteHint.${uiSiteId}`)}</p>
                  <p className="m-0 text-xs text-text-2" role="status">
                    {status}
                  </p>
                  {uiSiteId === 'pixiv-novel' && connected ? (
                    <p className="m-0 text-xs text-text-3">{t.t('ui.settings.accounts.pixivNovelShared')}</p>
                  ) : null}
                  {unsupported ? (
                    <p className="m-0 text-xs text-text-3">{t.t('ui.settings.accounts.flickrNeedsKeys')}</p>
                  ) : null}
                </div>
                {apiKeyAuth ? (
                  connected ? (
                    <Button size="md" variant="ghost" disabled={busy} onClick={() => void disconnect(uiSiteId)}>
                      {busy ? (
                        <>
                          <Spinner />
                          {t.t('ui.settings.accounts.connecting')}
                        </>
                      ) : (
                        t.t('ui.settings.accounts.disconnect')
                      )}
                    </Button>
                  ) : (
                    <Button
                      size="md"
                      variant="primary"
                      disabled={busy || vaultDisabled || !apiKeyPaste.trim()}
                      onClick={() => void saveApiKey(uiSiteId)}
                    >
                      {busy ? (
                        <>
                          <Spinner />
                          {t.t('ui.settings.accounts.connecting')}
                        </>
                      ) : (
                        t.t('ui.settings.accounts.saveApiKey')
                      )}
                    </Button>
                  )
                ) : (
                  <Button
                    size="md"
                    variant={connected ? 'ghost' : 'primary'}
                    disabled={busy || unsupported || (vaultDisabled && !connected)}
                    onClick={() => void runOAuth(uiSiteId, !connected)}
                  >
                    {busy ? (
                      <>
                        <Spinner />
                        {t.t('ui.settings.accounts.connecting')}
                      </>
                    ) : connected ? (
                      t.t('ui.settings.accounts.disconnect')
                    ) : (
                      t.t('ui.settings.accounts.connect')
                    )}
                  </Button>
                )}
              </div>
              {apiKeyAuth && !connected ? (
                <div className="space-y-1.5">
                  <Input
                    value={apiKeyPaste}
                    onChange={(event) => setApiKeyPaste(event.target.value)}
                    placeholder={t.t('ui.settings.accounts.apiKeyPlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy || vaultDisabled}
                    aria-label={t.t('ui.settings.accounts.apiKeyPlaceholder')}
                  />
                  <p className="m-0 text-xs text-text-3">{t.t('ui.settings.accounts.apiKeyHelp')}</p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {vaultDisabled ? (
        <p className="m-0 flex items-start gap-2 rounded-md border border-warn/25 bg-warn/[0.08] px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          {t.t('errors.VAULT_UNAVAILABLE')}
        </p>
      ) : secretsProtected === false ? (
        <p className="m-0 flex items-start gap-2 rounded-md border border-warn/25 bg-warn/[0.08] px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          {t.t('ui.settings.accounts.weakProtection')}
        </p>
      ) : null}
    </SettingsBlock>
  );
}

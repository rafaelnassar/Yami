/**
 * Persistent notice while the host runs with a disabled vault (`HostConfigDto.vault`): a
 * sticky toast with a "Reset vault" action. It comes back on every start until the vault
 * works; dismissing it hides it for the session (Settings › Cookies keeps a banner).
 */
import type { VaultStatusDto } from '../../../shared/contracts/dto.ts';
import { key, type NoticesStore } from '../notices/notices-store.ts';

export const VAULT_NOTICE_ID = 'vault-unavailable';

/** Identity of a vault status, for change detection (state snapshots are new objects). */
export function vaultStatusKey(vault: VaultStatusDto | null | undefined): string {
  if (!vault) return '';
  return vault.state === 'ready' ? 'ready' : `disabled:${vault.reason}`;
}

/** Shows or removes the notice for `vault`; `null` (no host state yet) changes nothing. */
export function syncVaultNotice(notices: NoticesStore, vault: VaultStatusDto | null): void {
  if (!vault) return;
  const store = notices.getState();
  if (vault.state === 'ready') {
    if (store.toasts.some((toast) => toast.id === VAULT_NOTICE_ID)) store.remove(VAULT_NOTICE_ID);
    return;
  }
  store.push({
    id: VAULT_NOTICE_ID,
    kind: 'warn',
    title: key('ui.vault.notice.title'),
    message: key('ui.vault.notice.message'),
    action: { type: 'vault-reset' },
    sticky: true,
    rememberDismissal: true
  });
}

/** Cookie files (Netscape format), default file, browser cookies and per-domain rules. */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Cookie, Trash2, Upload } from 'lucide-react';
import { LIMITS } from '../../../../shared/contracts/host-protocol.ts';
import { useCookies, useHost, useServices } from '../../../app/services-context.tsx';
import { useFormat, useT } from '../../../shared/i18n/i18n-context.tsx';
import { Button } from '../../../shared/ui/button.tsx';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog.tsx';
import { InlineError } from '../../../shared/ui/InlineError.tsx';
import { Label } from '../../../shared/ui/label.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../shared/ui/select.tsx';
import { LabeledSwitch } from '../../../shared/ui/labeled-switch.tsx';
import type { MessageKey } from '../../../../shared/i18n/catalog.ts';
import { toAppErrorData, type AppErrorData } from '../../../../shared/kernel/errors.ts';
import { errorText, key } from '../../notices/notices-store.ts';
import { SettingHint, SettingsBlock } from '../SettingsBlock.tsx';
import { CookieBindingsEditor } from './CookieBindingsEditor.tsx';
import { cookieUploadProblem, type CookieUploadProblem } from './cookie-upload.ts';
import { VaultUnavailableBanner } from './VaultUnavailableBanner.tsx';

const EMPTY: never[] = [];

const PROBLEM_TEXT: Readonly<
  Record<CookieUploadProblem, { readonly title: MessageKey; readonly message: MessageKey }>
> = {
  extension: { title: 'ui.settings.cookies.wrongType', message: 'ui.settings.cookies.wrongTypeMsg' },
  name: { title: 'ui.settings.cookies.invalidName', message: 'ui.settings.cookies.invalidNameMsg' },
  size: { title: 'ui.settings.cookies.tooLarge', message: 'ui.settings.cookies.tooLargeMsg' },
  empty: { title: 'ui.settings.cookies.emptyFile', message: 'ui.settings.cookies.emptyFileMsg' }
};

export function CookiesSection() {
  const t = useT();
  const format = useFormat();
  const { cookies, notices } = useServices();
  const snapshot = useCookies((state) => state.snapshot);
  const loadError = useCookies((state) => state.error);
  const loading = useCookies((state) => state.loading);
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const files = snapshot?.files ?? EMPTY;
  const names = useMemo(() => files.map((file) => file.name), [files]);
  const active = snapshot?.active ?? null;
  // Disabled vault: stored files cannot be read or changed (browser cookies still work).
  const vaultProblem = useHost((state) =>
    state.state?.config.vault.state === 'disabled' ? state.state.config.vault.reason : null
  );

  useEffect(() => {
    void cookies.getState().load();
  }, [cookies]);

  const report = (
    error: AppErrorData | null,
    failTitle: MessageKey,
    success?: MessageKey,
    params?: Record<string, string>
  ): void => {
    const toast = notices.getState();
    if (error) toast.push({ kind: 'error', title: key(failTitle), message: errorText(error) });
    else if (success)
      toast.push({
        kind: 'success',
        title: key(success),
        ...(params ? { message: key('ui.settings.cookies.uploadedMsg', params) } : {})
      });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = cookieUploadProblem(file);
    if (problem) {
      const text = PROBLEM_TEXT[problem];
      notices.getState().push({
        kind: 'error',
        title: key(text.title),
        message: key(text.message, { name: file.name, max: format.bytes(LIMITS.maxCookieFileBytes) })
      });
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch (error) {
      // The file can vanish or become unreadable between picking and reading.
      notices
        .getState()
        .push({ kind: 'error', title: key('ui.settings.cookies.readFail'), message: errorText(toAppErrorData(error)) });
      return;
    }
    report(
      await cookies.getState().upload(file.name, content),
      'ui.settings.cookies.uploadFail',
      'ui.settings.cookies.uploaded',
      { name: file.name }
    );
  };

  return (
    <SettingsBlock title={t.t('ui.settings.cookies.title')} icon={Cookie}>
      <div className="space-y-3">
        {loadError ? (
          <InlineError
            title={t.t('ui.settings.cookies.loadFail')}
            error={loadError}
            retrying={loading}
            onRetry={() => void cookies.getState().load()}
          />
        ) : null}
        {vaultProblem ? <VaultUnavailableBanner reason={vaultProblem} /> : null}
        <div className="space-y-2" hidden={vaultProblem !== null}>
          <Label htmlFor="cookie-default">{t.t('ui.settings.cookies.default')}</Label>
          <div className="flex gap-2">
            <Select
              value={active ?? '__none__'}
              onValueChange={(value) =>
                void cookies
                  .getState()
                  .select(value === '__none__' ? null : value)
                  .then((error) => report(error, 'ui.settings.cookies.selectFail'))
              }
            >
              <SelectTrigger id="cookie-default" className="min-w-0 flex-1">
                <SelectValue placeholder={t.t('ui.settings.cookies.none')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t.t('ui.settings.cookies.none')}</SelectItem>
                {names.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="md"
              iconOnly
              onClick={() => fileRef.current?.click()}
              aria-label={t.t('ui.settings.cookies.upload')}
              title={t.t('ui.settings.cookies.upload')}
            >
              <Upload className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </Button>
            <Button
              size="md"
              iconOnly
              variant="danger"
              onClick={() => setConfirmDelete(true)}
              disabled={!active}
              aria-label={t.t('ui.settings.cookies.remove')}
              title={t.t('ui.settings.cookies.remove')}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,text/plain"
              hidden
              aria-describedby="cookie-file-hint"
              onChange={(event) => void upload(event)}
            />
          </div>
          <SettingHint id="cookie-file-hint">
            {t.t('ui.settings.cookies.fileHint', { max: format.bytes(LIMITS.maxCookieFileBytes) })}
          </SettingHint>
        </div>

        <div className="space-y-2 border-t border-border/60 pt-4">
          <LabeledSwitch
            id="cookies-from-browser"
            checked={snapshot?.fromBrowser === true}
            onCheckedChange={(checked) =>
              void cookies
                .getState()
                .setFromBrowser(checked)
                .then((error) => report(error, 'ui.settings.cookies.browserFail'))
            }
            label={t.t('ui.settings.cookies.browserLabel')}
            describedBy="cookies-from-browser-hint"
            disabled={!snapshot}
          />
          <SettingHint id="cookies-from-browser-hint">{t.t('ui.settings.cookies.browserHint')}</SettingHint>
        </div>

        {snapshot && !vaultProblem ? <CookieBindingsEditor bindings={snapshot.bindings} files={names} /> : null}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t.t('ui.settings.cookies.deleteTitle')}
        message={active ? t.t('ui.settings.cookies.deleteMessage', { name: active }) : ''}
        confirmLabel={t.t('ui.settings.cookies.deleteConfirm')}
        cancelLabel={t.t('ui.common.cancel')}
        danger
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          if (!active) return;
          setDeleting(true);
          void cookies
            .getState()
            .remove(active)
            .then((error) => report(error, 'ui.settings.cookies.deleteFail', 'ui.settings.cookies.removed'))
            .finally(() => {
              setDeleting(false);
              setConfirmDelete(false);
            });
        }}
      />
    </SettingsBlock>
  );
}

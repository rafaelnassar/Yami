/** Language, behavior, privacy and download-folder settings. */
import { useState } from 'react';
import { EyeOff, Folder, FolderOpen, Languages, SlidersHorizontal } from 'lucide-react';
import { LOCALES, type AppSettingsPatch, type Locale } from '../../../shared/contracts/app-settings.ts';
import { LOCALE_LABELS } from '../../../shared/i18n/catalog.ts';
import type { MessageKey } from '../../../shared/i18n/catalog.ts';
import { useHost, useServices, useSettings } from '../../app/services-context.tsx';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { Button } from '../../shared/ui/button.tsx';
import { Input } from '../../shared/ui/input.tsx';
import { Label } from '../../shared/ui/label.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../shared/ui/select.tsx';
import { Spinner } from '../../shared/ui/spinner.tsx';
import { LabeledSwitch } from '../../shared/ui/labeled-switch.tsx';
import { errorText, key } from '../notices/notices-store.ts';
import { SettingHint, SettingsBlock } from './SettingsBlock.tsx';

function useUpdateSetting(): (patch: AppSettingsPatch) => void {
  const { settings, notices } = useServices();
  return (patch) => {
    void settings
      .getState()
      .update(patch)
      .then((error) => {
        if (error)
          notices.getState().push({ kind: 'error', title: key('ui.settings.saveFail'), message: errorText(error) });
      });
  };
}

export function LanguageSection() {
  const t = useT();
  const locale = useSettings((state) => state.settings.locale);
  const update = useUpdateSetting();
  return (
    <SettingsBlock title={t.t('ui.settings.language.title')} icon={Languages}>
      <div className="space-y-2">
        <Label htmlFor="app-locale">{t.t('ui.settings.language.label')}</Label>
        <Select value={locale} onValueChange={(value) => update({ locale: value as Locale })}>
          <SelectTrigger id="app-locale" className="max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCALES.map((code) => (
              <SelectItem key={code} value={code} lang={code}>
                {LOCALE_LABELS[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </SettingsBlock>
  );
}

type BehaviorField = 'closeToTray' | 'notifications' | 'clipboardWatch' | 'autoUpdate';

function behaviorPatch(field: BehaviorField, value: boolean): AppSettingsPatch {
  switch (field) {
    case 'closeToTray':
      return { closeToTray: value };
    case 'notifications':
      return { notifications: value };
    case 'clipboardWatch':
      return { clipboardWatch: value };
    case 'autoUpdate':
      return { autoUpdate: value };
  }
}

const BEHAVIOR_SWITCHES: ReadonlyArray<{
  readonly field: BehaviorField;
  readonly label: MessageKey;
  readonly hint: MessageKey;
}> = [
  { field: 'closeToTray', label: 'ui.settings.general.closeToTray', hint: 'ui.settings.general.closeToTrayHint' },
  { field: 'notifications', label: 'ui.settings.general.notifications', hint: 'ui.settings.general.notificationsHint' },
  {
    field: 'clipboardWatch',
    label: 'ui.settings.general.clipboardWatch',
    hint: 'ui.settings.general.clipboardWatchHint'
  },
  { field: 'autoUpdate', label: 'ui.settings.general.autoUpdate', hint: 'ui.settings.general.autoUpdateHint' }
];

export function BehaviorSection() {
  const t = useT();
  const settings = useSettings((state) => state.settings);
  const update = useUpdateSetting();
  return (
    <SettingsBlock title={t.t('ui.settings.general.title')} icon={SlidersHorizontal}>
      {BEHAVIOR_SWITCHES.map((item) => (
        <div key={item.field} className="space-y-1">
          <LabeledSwitch
            id={`setting-${item.field}`}
            checked={settings[item.field]}
            onCheckedChange={(checked) => update(behaviorPatch(item.field, checked))}
            label={t.t(item.label)}
            describedBy={`setting-${item.field}-hint`}
          />
          <SettingHint id={`setting-${item.field}-hint`}>{t.t(item.hint)}</SettingHint>
        </div>
      ))}
    </SettingsBlock>
  );
}

export function PrivacySection() {
  const t = useT();
  const adultBlur = useSettings((state) => state.settings.adultBlur);
  const update = useUpdateSetting();
  return (
    <SettingsBlock title={t.t('ui.settings.privacy.title')} icon={EyeOff}>
      <div className="space-y-2">
        <LabeledSwitch
          id="blur-adult-content"
          checked={adultBlur}
          onCheckedChange={(checked) => update({ adultBlur: checked })}
          label={t.t('ui.settings.privacy.blurLabel')}
          describedBy="blur-adult-hint"
        />
        <SettingHint id="blur-adult-hint">{t.t('ui.settings.privacy.blurHint')}</SettingHint>
      </div>
    </SettingsBlock>
  );
}

export function DownloadDirSection() {
  const t = useT();
  const { client, notices } = useServices();
  const downloadDir = useHost((state) => state.state?.config.downloadDir ?? '');
  const [choosing, setChoosing] = useState(false);

  const choose = async (): Promise<void> => {
    setChoosing(true);
    const result = await client.call((api) => api.dialogs.chooseDownloadDir());
    setChoosing(false);
    if (!result.ok) {
      notices
        .getState()
        .push({ kind: 'error', title: key('ui.settings.downloadDir.failTitle'), message: errorText(result.error) });
      return;
    }
    if (result.data)
      notices.getState().push({
        kind: 'success',
        title: key('ui.settings.downloadDir.saved'),
        message: { kind: 'raw', text: result.data.downloadDir }
      });
  };

  return (
    <SettingsBlock title={t.t('ui.settings.downloadDir.title')} icon={Folder}>
      <div className="space-y-2">
        <Label htmlFor="download-dir">{t.t('ui.settings.downloadDir.label')}</Label>
        <div className="flex gap-2">
          <Input
            id="download-dir"
            value={downloadDir}
            readOnly
            placeholder={t.t('ui.settings.downloadDir.placeholder')}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            size="md"
            iconOnly
            variant="secondary"
            onClick={() => void choose()}
            disabled={choosing}
            aria-label={t.t('ui.settings.downloadDir.choose')}
            title={t.t('ui.settings.downloadDir.choose')}
          >
            {choosing ? <Spinner /> : <FolderOpen strokeWidth={1.75} aria-hidden />}
          </Button>
        </div>
      </div>
    </SettingsBlock>
  );
}

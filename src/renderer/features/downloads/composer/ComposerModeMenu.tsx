/** Mode (single link / batch) and engine picker of the composer. */
import { ChevronDown, Images, Layers3, Link2, Video, type LucideIcon } from 'lucide-react';
import type { DownloadScope, Engine } from '../../../../shared/domain/engine.ts';
import type { MessageKey } from '../../../../shared/i18n/catalog.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { MenuButton, type MenuItemSpec } from '../../../shared/ui/Menu.tsx';
import { Badge } from '../../../shared/ui/badge.tsx';

export const MODE_META: Record<DownloadScope, { icon: LucideIcon; label: MessageKey; description: MessageKey }> = {
  single: { icon: Link2, label: 'ui.composer.mode.single', description: 'ui.composer.mode.singleDesc' },
  bulk: { icon: Layers3, label: 'ui.composer.mode.bulk', description: 'ui.composer.mode.bulkDesc' }
};

export const ENGINE_META: Record<Engine, { icon: LucideIcon; label: MessageKey; description: MessageKey }> = {
  'gallery-dl': { icon: Images, label: 'ui.composer.engine.gallery', description: 'ui.composer.engine.galleryDesc' },
  'yt-dlp': { icon: Video, label: 'ui.composer.engine.video', description: 'ui.composer.engine.videoDesc' }
};

const ICON_CLASS = 'icon-inline';

export interface ComposerModeMenuProps {
  readonly mode: DownloadScope;
  readonly engine: Engine;
  /** Engines known to be missing (only when the host state is available). */
  readonly missing: ReadonlySet<Engine>;
  readonly onModeChange: (mode: DownloadScope) => void;
  readonly onEngineChange: (engine: Engine) => void;
}

export function ComposerModeMenu({ mode, engine, missing, onModeChange, onEngineChange }: ComposerModeMenuProps) {
  const t = useT();
  const ModeIcon = MODE_META[mode].icon;
  const EngineIcon = ENGINE_META[engine].icon;

  const items: MenuItemSpec[] = [
    { id: 'mode-heading', kind: 'heading', label: t.t('ui.composer.modeAria') },
    ...(['single', 'bulk'] as const).map((key): MenuItemSpec => {
      const Icon = MODE_META[key].icon;
      return {
        id: `mode-${key}`,
        kind: 'radio',
        checked: mode === key,
        label: t.t(MODE_META[key].label),
        icon: <Icon className={ICON_CLASS} strokeWidth={1.75} aria-hidden />,
        onSelect: () => onModeChange(key)
      };
    }),
    { id: 'engine-heading', kind: 'heading', label: t.t('ui.composer.engineAria') },
    ...(['gallery-dl', 'yt-dlp'] as const).map((key): MenuItemSpec => {
      const Icon = ENGINE_META[key].icon;
      return {
        id: `engine-${key}`,
        kind: 'radio',
        checked: engine === key,
        label: t.t(ENGINE_META[key].label),
        description: t.t(ENGINE_META[key].description),
        icon: <Icon className={ICON_CLASS} strokeWidth={1.75} aria-hidden />,
        trailing: missing.has(key) ? <Badge variant="warn">{t.t('ui.engine.missing')}</Badge> : undefined,
        onSelect: () => onEngineChange(key)
      };
    })
  ];

  return (
    <MenuButton
      items={items}
      menuLabel={t.t('ui.composer.modeEngineAria')}
      triggerLabel={`${t.t('ui.composer.modeEngineAria')}: ${t.t(MODE_META[mode].label)} · ${t.t(ENGINE_META[engine].label)}`}
      title={t.t('ui.composer.modeEngineAria')}
      width={340}
      align="start"
      triggerClassName="inline-flex h-11 min-h-11 max-w-full cursor-pointer items-center justify-start gap-2 rounded-md border border-transparent px-3 text-xs font-medium leading-none text-text-2 transition-colors duration-200 hover:border-border hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      triggerContent={
        <>
          <ModeIcon className="icon-inline self-center" strokeWidth={1.75} aria-hidden />
          <span className="composer-mode-label truncate leading-none">{t.t(MODE_META[mode].label)}</span>
          <span className="composer-engine-detail shrink-0 leading-none text-text-4" aria-hidden>
            ·
          </span>
          <EngineIcon className="icon-inline self-center text-text-3" strokeWidth={1.75} aria-hidden />
          <span className="composer-engine-detail truncate leading-none text-text-3">
            {t.t(ENGINE_META[engine].label)}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 self-center text-text-4" strokeWidth={1.75} aria-hidden />
        </>
      }
    />
  );
}

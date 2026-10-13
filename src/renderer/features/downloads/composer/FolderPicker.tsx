/** Destination sidebar folder for the next download(s). */
import { ChevronDown, Folder } from 'lucide-react';
import type { FolderDto } from '../../../../shared/contracts/dto.ts';
import { useT } from '../../../shared/i18n/i18n-context.tsx';
import { MenuButton, type MenuItemSpec } from '../../../shared/ui/Menu.tsx';

export interface FolderPickerProps {
  readonly folders: readonly FolderDto[];
  readonly selected: FolderDto | null;
  readonly onChange: (folderId: string | null) => void;
}

export function FolderPicker({ folders, selected, onChange }: FolderPickerProps) {
  const t = useT();
  const items: MenuItemSpec[] = [
    {
      id: 'none',
      kind: 'radio',
      checked: selected === null,
      label: t.t('ui.folders.none'),
      icon: <Folder className="h-4 w-4 shrink-0 text-text-4" strokeWidth={1.75} aria-hidden />,
      onSelect: () => onChange(null)
    },
    ...folders.map((folder): MenuItemSpec => ({
      id: folder.id,
      kind: 'radio',
      checked: selected?.id === folder.id,
      label: folder.name,
      icon: <Folder className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden style={{ color: folder.color }} />,
      onSelect: () => onChange(folder.id)
    }))
  ];

  return (
    <MenuButton
      items={items}
      menuLabel={t.t('ui.composer.folderAria')}
      triggerLabel={`${t.t('ui.composer.folderAria')}: ${selected ? selected.name : t.t('ui.folders.none')}`}
      title={t.t('ui.composer.folderPick')}
      width={280}
      align="start"
      triggerClassName="inline-flex h-11 min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-3 text-xs font-medium text-text-2 transition-colors duration-200 hover:border-border hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      triggerContent={
        <>
          <Folder
            className="h-4 w-4 shrink-0"
            strokeWidth={1.75}
            aria-hidden
            style={selected ? { color: selected.color } : undefined}
          />
          <span className="max-w-[8.5rem] truncate sm:max-w-[11rem]">
            {selected ? selected.name : t.t('ui.folders.none')}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-4" strokeWidth={1.75} aria-hidden />
        </>
      }
    />
  );
}

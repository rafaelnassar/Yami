/** Folder colour palette (contrast-checked on the dark UI) with i18n names for screen readers. */
import type { MessageKey } from '../../../../shared/i18n/catalog.ts';

export const FOLDER_COLORS: ReadonlyArray<{ readonly hex: string; readonly label: MessageKey }> = [
  { hex: '#94A3B8', label: 'ui.folderColor.slate' },
  { hex: '#A8A29E', label: 'ui.folderColor.stone' },
  { hex: '#CBD5E1', label: 'ui.folderColor.snow' },
  { hex: '#60A5FA', label: 'ui.folderColor.blue' },
  { hex: '#38BDF8', label: 'ui.folderColor.sky' },
  { hex: '#22D3EE', label: 'ui.folderColor.cyan' },
  { hex: '#818CF8', label: 'ui.folderColor.indigo' },
  { hex: '#A78BFA', label: 'ui.folderColor.violet' },
  { hex: '#C084FC', label: 'ui.folderColor.purple' },
  { hex: '#E879F9', label: 'ui.folderColor.fuchsia' },
  { hex: '#F472B6', label: 'ui.folderColor.pink' },
  { hex: '#FB7185', label: 'ui.folderColor.coral' },
  { hex: '#F87171', label: 'ui.folderColor.red' },
  { hex: '#FB923C', label: 'ui.folderColor.orange' },
  { hex: '#FBBF24', label: 'ui.folderColor.amber' },
  { hex: '#FACC15', label: 'ui.folderColor.yellow' },
  { hex: '#A3E635', label: 'ui.folderColor.lime' },
  { hex: '#4ADE80', label: 'ui.folderColor.green' },
  { hex: '#34D399', label: 'ui.folderColor.emerald' },
  { hex: '#2DD4BF', label: 'ui.folderColor.teal' }
];

export const DEFAULT_FOLDER_COLOR = FOLDER_COLORS[0]?.hex ?? '#94A3B8';

export const CONVERSATION_DRAG_MIME = 'application/x-yami-conversation-id';

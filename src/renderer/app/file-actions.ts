/**
 * OS integrations through main: open a file (main applies the risk policy and a
 * native confirmation), reveal in the file manager, open external links.
 * The renderer keeps no deny-list of its own.
 */
import type { YamiClient } from '../shared/api/yami-client.ts';
import { errorText, key, type NoticesStore } from '../features/notices/notices-store.ts';

export interface FileActions {
  openFile(path: string): Promise<void>;
  revealFile(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export function createFileActions(deps: { readonly client: YamiClient; readonly notices: NoticesStore }): FileActions {
  const toast = deps.notices.getState();
  return {
    async openFile(path) {
      const result = await deps.client.call((api) => api.shell.openFile(path));
      if (!result.ok) {
        toast.push({ kind: 'error', title: key('ui.files.openFail'), message: errorText(result.error) });
        return;
      }
      if (result.data.action === 'revealed') {
        toast.push({
          kind: 'info',
          title: key('ui.files.revealedInstead'),
          message: key('ui.files.revealedInsteadMsg')
        });
      }
    },
    async revealFile(path) {
      const result = await deps.client.call((api) => api.shell.revealFile(path));
      if (!result.ok)
        toast.push({ kind: 'error', title: key('ui.files.revealFail'), message: errorText(result.error) });
    },
    async openExternal(url) {
      const result = await deps.client.call((api) => api.shell.openExternal(url));
      if (!result.ok)
        toast.push({ kind: 'error', title: key('ui.files.openLinkFail'), message: errorText(result.error) });
    }
  };
}

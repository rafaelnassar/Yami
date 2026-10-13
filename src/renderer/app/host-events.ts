/**
 * Routes host events (broadcast by main to every window) to the stores.
 */
import type { HostEvent } from '../../shared/contracts/host-protocol.ts';
import type { DownloadFinishedDto } from '../../shared/contracts/dto.ts';
import { key } from '../features/notices/notices-store.ts';
import type { Services } from './services.ts';

function reportFinished(services: Services, download: DownloadFinishedDto): void {
  if (services.active.getState().id !== download.conversationId) return;
  const toast = services.notices.getState();
  if (download.status === 'completed') {
    toast.push({
      kind: download.outcome.kind === 'partial' ? 'warn' : 'success',
      title: key('ui.session.toast.completed'),
      message: key('ui.session.toast.completedMsg', { count: download.counters.done })
    });
  } else {
    toast.push({
      kind: 'error',
      title: key('ui.session.toast.failed'),
      message: { kind: 'outcome', outcome: download.outcome }
    });
  }
}

export function routeHostEvent(services: Services, event: HostEvent): void {
  switch (event.type) {
    case 'state':
      services.host.getState().receiveState(event.state);
      return;
    case 'log':
      services.logs.getState().append(event.entries);
      return;
    case 'files.added':
      services.active.getState().appendFiles(event.items);
      return;
    case 'notice':
      services.notices.getState().receiveNotice(event.notice);
      return;
    case 'notice.dismissed':
      services.notices.getState().remove(event.id);
      return;
    case 'runtime.progress':
      services.runtime.getState().receiveProgress(event.progress);
      return;
    case 'runtime.operationFinished': {
      const finished = services.runtime.getState().receiveFinished(event.operationId, event.ok, event.error);
      services.actions.runtime.reportFinished(finished);
      return;
    }
    case 'conversation.changed':
      if (event.reason === 'deleted') {
        services.conversations.getState().remove(event.conversationId);
        if (services.active.getState().id === event.conversationId) services.active.getState().open(null);
        return;
      }
      services.conversations.getState().scheduleRefresh();
      if (services.active.getState().id === event.conversationId) services.active.getState().scheduleReload();
      return;
    case 'download.finished':
      services.conversations.getState().scheduleRefresh();
      if (services.active.getState().id === event.download.conversationId) services.active.getState().scheduleReload();
      reportFinished(services, event.download);
      return;
    case 'batch.finished':
      // OS notifications for batches are shown by main.
      return;
    case 'folders.changed':
      if (services.folders.getState().loaded) void services.folders.getState().load();
      return;
    case 'cookies.changed':
      services.cookies.getState().receive(event.cookies);
      return;
  }
}

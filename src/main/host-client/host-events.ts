/**
 * Fans host events and connection status out to every app window (main *and* tray —
 * the legacy app never informed the tray) and to main-side consumers: notifications,
 * tray tooltip, taskbar progress.
 */
import type { BatchFinishedDto, DownloadFinishedDto, HostStateDto } from '../../shared/contracts/dto.ts';
import type { HostEvent } from '../../shared/contracts/host-protocol.ts';
import { IPC, type HostConnectionStatus } from '../../shared/contracts/ipc.ts';

export interface HostEventSource {
  onEvent(listener: (event: HostEvent) => void): () => void;
  onStatus(listener: (status: HostConnectionStatus) => void): () => void;
}

export interface HostEventRoutingDeps {
  readonly source: HostEventSource;
  readonly broadcast: (channel: string, payload: unknown) => void;
  readonly onDownloadFinished: (download: DownloadFinishedDto) => void;
  readonly onBatchFinished: (batch: BatchFinishedDto) => void;
  readonly onState: (state: HostStateDto) => void;
  readonly onStatus: (status: HostConnectionStatus) => void;
  /** Download history changed (clipboard suggestions cache it). */
  readonly onHistoryChanged: () => void;
}

export function routeHostEvents(deps: HostEventRoutingDeps): () => void {
  const offEvent = deps.source.onEvent((event) => {
    deps.broadcast(IPC.host.event, event);
    switch (event.type) {
      case 'state':
        deps.onState(event.state);
        break;
      case 'download.finished':
        deps.onDownloadFinished(event.download);
        break;
      case 'batch.finished':
        deps.onBatchFinished(event.batch);
        break;
      case 'conversation.changed':
        if (event.reason === 'created' || event.reason === 'deleted') deps.onHistoryChanged();
        break;
      default:
        break;
    }
  });
  const offStatus = deps.source.onStatus((status) => {
    deps.broadcast(IPC.host.status, status);
    deps.onStatus(status);
  });
  return () => {
    offEvent();
    offStatus();
  };
}

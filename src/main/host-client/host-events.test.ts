import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BatchFinishedDto, DownloadFinishedDto, HostStateDto } from '../../shared/contracts/dto.ts';
import type { HostEvent } from '../../shared/contracts/host-protocol.ts';
import type { HostConnectionStatus } from '../../shared/contracts/ipc.ts';
import { parseHostMessage } from './host-messages.ts';
import { routeHostEvents } from './host-events.ts';

function source() {
  const events = new Set<(event: HostEvent) => void>();
  const statuses = new Set<(status: HostConnectionStatus) => void>();
  return {
    onEvent: (listener: (event: HostEvent) => void) => {
      events.add(listener);
      return () => events.delete(listener);
    },
    onStatus: (listener: (status: HostConnectionStatus) => void) => {
      statuses.add(listener);
      return () => statuses.delete(listener);
    },
    emit: (event: HostEvent) => events.forEach((listener) => listener(event)),
    status: (status: HostConnectionStatus) => statuses.forEach((listener) => listener(status)),
    size: () => events.size + statuses.size
  };
}

describe('routeHostEvents', () => {
  it('broadcasts everything and dispatches to main-side consumers', () => {
    const src = source();
    const log: string[] = [];
    const off = routeHostEvents({
      source: src,
      broadcast: (channel, payload) =>
        log.push(
          `${channel}:${(payload as { type?: string; state?: string }).type ?? (payload as { state: string }).state}`
        ),
      onDownloadFinished: (download: DownloadFinishedDto) => log.push(`notify:${download.conversationId}`),
      onBatchFinished: (batch: BatchFinishedDto) => log.push(`batch:${batch.batchId}`),
      onState: (state: HostStateDto) => log.push(`state:${state.status}`),
      onStatus: (status) => log.push(`status:${status.state}`),
      onHistoryChanged: () => log.push('history')
    });
    src.emit({ type: 'state', state: { status: 'running' } as HostStateDto });
    src.emit({ type: 'download.finished', download: { conversationId: 'c1' } as DownloadFinishedDto });
    src.emit({ type: 'batch.finished', batch: { batchId: 'b1' } as BatchFinishedDto });
    src.emit({ type: 'conversation.changed', conversationId: 'c2', reason: 'created' });
    src.emit({ type: 'conversation.changed', conversationId: 'c2', reason: 'updated' });
    src.status({ state: 'ready' });
    assert.deepEqual(log, [
      'host:event:state',
      'state:running',
      'host:event:download.finished',
      'notify:c1',
      'host:event:batch.finished',
      'batch:b1',
      'host:event:conversation.changed',
      'history',
      'host:event:conversation.changed',
      'host:status:ready',
      'status:ready'
    ]);
    off();
    assert.equal(src.size(), 0);
  });
});

describe('parseHostMessage', () => {
  it('accepts well-formed envelopes and rejects the rest', () => {
    assert.deepEqual(parseHostMessage({ kind: 'ready', pid: 7 }), { kind: 'ready', pid: 7 });
    assert.deepEqual(parseHostMessage({ kind: 'response', id: 'm1', ok: true, data: 1 }), {
      kind: 'response',
      id: 'm1',
      ok: true,
      data: 1
    });
    assert.deepEqual(parseHostMessage({ kind: 'response', id: 'm1', ok: false, error: { code: 'HOST_TIMEOUT' } }), {
      kind: 'response',
      id: 'm1',
      ok: false,
      error: { code: 'HOST_TIMEOUT' }
    });
    const malformed = parseHostMessage({ kind: 'response', id: 'm1', ok: false, error: { code: 'NOPE' } });
    assert.equal(malformed?.kind === 'response' && !malformed.ok && malformed.error.code, 'INTERNAL');
    assert.equal(parseHostMessage({ kind: 'event', event: { nope: 1 } }), null);
    assert.equal(parseHostMessage({ kind: 'response', ok: true }), null);
    assert.equal(parseHostMessage('ready'), null);
  });
});

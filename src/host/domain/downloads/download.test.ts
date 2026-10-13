import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DownloadStatus } from '../../../shared/domain/download.ts';
import type { ParsedLine } from '../engines/parsed-line.ts';
import type { ProcessIdentity } from '../processes/process-identity.ts';
import { Download } from './download.ts';
import { EMPTY_COUNTERS, INITIAL_RETRY, type DownloadState } from './download-state.ts';

const PROCESS: ProcessIdentity = {
  pid: 42,
  imageName: 'yt-dlp',
  startToken: '1',
  startTokenSource: 'proc',
  executable: '/bin/yt-dlp',
  capturedAt: 1
};

function newDownload(): Download {
  return Download.create({
    id: 'd1',
    batchId: 'b1',
    sourceUrl: 'https://example.com/a',
    title: 'a',
    engine: 'yt-dlp',
    scope: 'single',
    cookieName: null,
    folderId: null,
    position: 1,
    now: 100
  });
}

function stateWith(status: DownloadStatus, extra: Partial<DownloadState> = {}): DownloadState {
  return { ...newDownload().toState(), status, ...extra };
}

function running(): Download {
  const download = newDownload();
  assert.ok(
    download.markRunning({ process: PROCESS, logFile: '/log', usedBrowserCookies: false, knownFiles: [], now: 200 }).ok
  );
  download.pullEvents();
  return download;
}

const errorLine = (message: string, fatal = true): ParsedLine => ({
  kind: 'error',
  errorKind: 'network',
  message,
  fatal,
  text: `ERROR: ${message}`
});

type Action = 'start' | 'pause' | 'resume' | 'cancel' | 'restart' | 'finish' | 'retry' | 'exit';

function act(download: Download, action: Action): string {
  const result = (() => {
    switch (action) {
      case 'start':
        return download.markRunning({
          process: PROCESS,
          logFile: '/log',
          usedBrowserCookies: false,
          knownFiles: [],
          now: 1
        });
      case 'pause':
        return download.pause(1);
      case 'resume':
        return download.resume(1);
      case 'cancel':
        return download.cancel(1);
      case 'restart':
        return download.restart(1, 9);
      case 'finish':
        return download.finish({ kind: 'ok', reason: null, detail: null }, 1);
      case 'retry':
        return download.requeueForRetry('skip', 1);
      case 'exit':
        return download.requeueOnExit(1);
    }
  })();
  return result.ok ? download.status : result.error.code;
}

describe('Download state machine', () => {
  // Expected resulting status, or the error code of the refused transition.
  const TABLE: Record<DownloadStatus, Record<Action, string>> = {
    pending: {
      start: 'running',
      pause: 'paused',
      resume: 'DOWNLOAD_NOT_PAUSED',
      cancel: 'cancelled',
      restart: 'DOWNLOAD_STILL_ACTIVE',
      finish: 'completed',
      retry: 'DOWNLOAD_INVALID_TRANSITION',
      exit: 'DOWNLOAD_INVALID_TRANSITION'
    },
    running: {
      start: 'DOWNLOAD_INVALID_TRANSITION',
      pause: 'paused',
      resume: 'DOWNLOAD_NOT_PAUSED',
      cancel: 'cancelled',
      restart: 'DOWNLOAD_STILL_ACTIVE',
      finish: 'completed',
      retry: 'pending',
      exit: 'pending'
    },
    paused: {
      start: 'DOWNLOAD_INVALID_TRANSITION',
      pause: 'paused',
      resume: 'pending',
      cancel: 'cancelled',
      restart: 'DOWNLOAD_STILL_ACTIVE',
      finish: 'DOWNLOAD_INVALID_TRANSITION',
      retry: 'DOWNLOAD_INVALID_TRANSITION',
      exit: 'DOWNLOAD_INVALID_TRANSITION'
    },
    completed: {
      start: 'DOWNLOAD_INVALID_TRANSITION',
      pause: 'DOWNLOAD_NOT_ACTIVE',
      resume: 'DOWNLOAD_NOT_PAUSED',
      cancel: 'DOWNLOAD_NOT_ACTIVE',
      restart: 'pending',
      finish: 'DOWNLOAD_INVALID_TRANSITION',
      retry: 'DOWNLOAD_INVALID_TRANSITION',
      exit: 'DOWNLOAD_INVALID_TRANSITION'
    },
    failed: {
      start: 'DOWNLOAD_INVALID_TRANSITION',
      pause: 'DOWNLOAD_NOT_ACTIVE',
      resume: 'DOWNLOAD_NOT_PAUSED',
      cancel: 'DOWNLOAD_NOT_ACTIVE',
      restart: 'pending',
      finish: 'DOWNLOAD_INVALID_TRANSITION',
      retry: 'DOWNLOAD_INVALID_TRANSITION',
      exit: 'DOWNLOAD_INVALID_TRANSITION'
    },
    cancelled: {
      start: 'DOWNLOAD_INVALID_TRANSITION',
      pause: 'DOWNLOAD_NOT_ACTIVE',
      resume: 'DOWNLOAD_NOT_PAUSED',
      cancel: 'DOWNLOAD_NOT_ACTIVE',
      restart: 'pending',
      finish: 'DOWNLOAD_INVALID_TRANSITION',
      retry: 'DOWNLOAD_INVALID_TRANSITION',
      exit: 'DOWNLOAD_INVALID_TRANSITION'
    }
  };

  for (const [from, row] of Object.entries(TABLE) as [DownloadStatus, Record<Action, string>][]) {
    for (const [action, expected] of Object.entries(row) as [Action, string][]) {
      it(`${from} --${action}--> ${expected}`, () => {
        const download = Download.restore(stateWith(from, from === 'running' ? { process: PROCESS } : {}));
        assert.equal(act(download, action), expected);
      });
    }
  }

  it('refused transitions leave the state untouched', () => {
    const download = Download.restore(stateWith('completed'));
    const before = download.toState();
    assert.equal(download.pause(5).ok, false);
    assert.deepEqual(download.toState(), before);
    assert.deepEqual(download.pullEvents(), []);
  });

  it('emits created on create and started on markRunning', () => {
    const download = newDownload();
    assert.deepEqual(
      download.pullEvents().map((e) => e.type),
      ['created']
    );
    download.markRunning({ process: PROCESS, logFile: '/log', usedBrowserCookies: true, knownFiles: [], now: 7 });
    const [event] = download.pullEvents();
    assert.deepEqual(event, { type: 'started', downloadId: 'd1', engine: 'yt-dlp', at: 7 });
    assert.equal(download.startedAt, 7);
    assert.equal(download.usedBrowserCookies, true);
    assert.equal(download.process?.pid, 42);
  });

  it('pause of a running download clears the process and reports wasRunning', () => {
    const download = running();
    download.pause(9, 'shutdown');
    assert.equal(download.process, null);
    assert.deepEqual(download.pullEvents(), [
      { type: 'paused', downloadId: 'd1', wasRunning: true, cause: 'shutdown', at: 9 }
    ]);
  });

  it('pausing an already paused download is a silent no-op', () => {
    const download = Download.restore(stateWith('paused'));
    assert.ok(download.pause(1).ok);
    assert.deepEqual(download.pullEvents(), []);
  });

  it('resume keeps done but recounts skipped and errors', () => {
    const download = Download.restore(
      stateWith('paused', { counters: { done: 3, skipped: 2, errors: 1 }, errorLines: ['x'], lastErrorKind: 'network' })
    );
    download.resume(5);
    assert.deepEqual(download.counters, { done: 3, skipped: 0, errors: 0 });
    assert.deepEqual(download.errorLines, []);
    assert.equal(download.lastErrorKind, null);
    assert.equal(download.logOffset, 0);
  });

  it('restart resets counters, outcome, errors and retry flags (legacy kept stats)', () => {
    const download = Download.restore(
      stateWith('failed', {
        counters: { done: 4, skipped: 1, errors: 2 },
        outcome: { kind: 'error', reason: 'network', detail: 'boom' },
        errorLines: ['boom'],
        lastErrorKind: 'network',
        retry: { browserCookieMode: 'force', skipTried: true, forceTried: true },
        usedBrowserCookies: true,
        completedAt: 50,
        startedAt: 40,
        logOffset: 999
      })
    );
    assert.ok(download.restart(60, 77).ok);
    const state = download.toState();
    assert.equal(state.status, 'pending');
    assert.equal(state.position, 77);
    assert.deepEqual(state.counters, EMPTY_COUNTERS);
    assert.equal(state.outcome, null);
    assert.deepEqual(state.errorLines, []);
    assert.deepEqual(state.retry, INITIAL_RETRY);
    assert.equal(state.usedBrowserCookies, false);
    assert.equal(state.completedAt, null);
    assert.equal(state.startedAt, null);
    assert.equal(state.logOffset, 0);
  });

  it('requeueOnExit puts a running download back in the queue at its position, keeping done and retry state', () => {
    const download = Download.restore(
      stateWith('running', {
        process: PROCESS,
        position: 4,
        counters: { done: 3, skipped: 2, errors: 1 },
        errorLines: ['x'],
        lastErrorKind: 'network',
        logOffset: 50,
        retry: { browserCookieMode: 'skip', skipTried: true, forceTried: false }
      })
    );
    assert.ok(download.requeueOnExit(9).ok);
    const state = download.toState();
    assert.equal(state.status, 'pending');
    assert.equal(state.position, 4);
    assert.equal(state.process, null);
    assert.equal(state.logOffset, 0);
    assert.deepEqual(state.counters, { done: 3, skipped: 0, errors: 0 });
    assert.deepEqual(state.errorLines, []);
    assert.deepEqual(state.retry, { browserCookieMode: 'skip', skipTried: true, forceTried: false });
    assert.deepEqual(download.pullEvents(), [
      { type: 'paused', downloadId: 'd1', wasRunning: true, cause: 'shutdown', at: 9 }
    ]);
  });

  it('cancel records a cancelled outcome and completion time', () => {
    const download = running();
    download.cancel(33);
    assert.equal(download.status, 'cancelled');
    assert.deepEqual(download.outcome, { kind: 'cancelled', reason: null, detail: null });
    assert.equal(download.completedAt, 33);
    assert.deepEqual(download.pullEvents(), [{ type: 'cancelled', downloadId: 'd1', wasRunning: true, at: 33 }]);
  });

  it('finish maps outcome kinds to statuses and emits finished', () => {
    const download = running();
    download.finish({ kind: 'empty', reason: 'empty-result', detail: null }, 12);
    assert.equal(download.status, 'failed');
    const [event] = download.pullEvents();
    assert.equal(event?.type, 'finished');
    const pending = newDownload();
    pending.finish({ kind: 'error', reason: 'engine-missing', detail: null }, 3);
    assert.equal(pending.status, 'failed');
  });

  it('requeueForRetry sets the retry flags and clears the failed run', () => {
    const download = running();
    download.applyLine(errorLine('cookie db locked'));
    assert.ok(download.requeueForRetry('skip', 9).ok);
    assert.equal(download.status, 'pending');
    assert.deepEqual(download.retry, { browserCookieMode: 'skip', skipTried: true, forceTried: false });
    assert.deepEqual(download.counters, EMPTY_COUNTERS);
    assert.deepEqual(download.errorLines, []);
    assert.deepEqual(download.pullEvents(), [{ type: 'retry-scheduled', downloadId: 'd1', mode: 'skip', at: 9 }]);
  });
});

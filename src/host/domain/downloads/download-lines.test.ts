import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DownloadStatus } from '../../../shared/domain/download.ts';
import type { ParsedLine } from '../engines/parsed-line.ts';
import type { ProcessIdentity } from '../processes/process-identity.ts';
import { Download } from './download.ts';
import { EMPTY_COUNTERS, type DownloadState } from './download-state.ts';

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

const fileLine = (path: string, status: 'downloaded' | 'skipped' = 'downloaded'): ParsedLine => ({
  kind: 'file',
  status,
  path,
  text: path
});

const errorLine = (message: string, fatal = true): ParsedLine => ({
  kind: 'error',
  errorKind: 'network',
  message,
  fatal,
  text: `ERROR: ${message}`
});

describe('Download.applyLine', () => {
  it('counts downloaded and skipped files once per run', () => {
    const download = running();
    assert.deepEqual(download.applyLine(fileLine('/dl/a.jpg')).file, { status: 'downloaded', path: '/dl/a.jpg' });
    assert.equal(download.applyLine(fileLine('/dl/a.jpg')).file, null);
    assert.ok(download.applyLine(fileLine('/dl/b.jpg', 'skipped')).file);
    // A path first seen as skipped is never re-counted as downloaded.
    assert.equal(download.applyLine(fileLine('/dl/b.jpg')).file, null);
    assert.deepEqual(download.counters, { done: 1, skipped: 1, errors: 0 });
    assert.equal(download.progress.currentFile, '/dl/b.jpg');
  });

  it('keeps at most 10 error lines and counts only fatal errors', () => {
    const download = running();
    for (let i = 0; i < 12; i += 1) download.applyLine(errorLine(`e${i}`, i % 2 === 0));
    assert.equal(download.errorLines.length, 10);
    assert.equal(download.errorLines[0], 'e2');
    assert.equal(download.lastErrorLine, 'e11');
    assert.equal(download.counters.errors, 6);
    assert.equal(download.lastErrorKind, 'network');
  });

  it('tracks progress per download and reports visible changes', () => {
    const download = running();
    const first = download.applyLine({ kind: 'progress', percent: 42.4, speed: '1MiB/s', eta: '00:10' });
    assert.equal(first.changed, true);
    const same = download.applyLine({ kind: 'progress', percent: 42.9, speed: '1MiB/s', eta: '00:10' });
    assert.equal(same.changed, false);
    assert.deepEqual(download.progress, { percent: 42.9, speed: '1MiB/s', eta: '00:10', currentFile: null });
    download.applyLine({ kind: 'progress', percent: 140, speed: null, eta: null });
    assert.equal(download.progress.percent, 100);
  });

  it('promotes a pending destination exactly once', () => {
    const download = running();
    download.applyLine({ kind: 'pending-file', path: '/dl/v.mp4', text: '' });
    assert.equal(download.progress.currentFile, '/dl/v.mp4');
    assert.equal(download.counters.done, 0);
    assert.ok(download.applyLine({ kind: 'promote-pending', text: '' }).file);
    assert.equal(download.applyLine({ kind: 'promote-pending', text: '' }).file, null);
    assert.equal(download.counters.done, 1);
  });

  it('a final file detection prevents a later promotion of the pending destination', () => {
    const download = running();
    download.applyLine({ kind: 'pending-file', path: '/tmp/v.f1.mp4', text: '' });
    download.applyLine(fileLine('/dl/v.mp4'));
    assert.equal(download.applyLine({ kind: 'promote-pending', text: '' }).file, null);
    assert.equal(download.counters.done, 1);
  });

  it('ignores files already counted by a previous attempt when done is carried over', () => {
    const download = Download.restore(
      stateWith('running', { process: PROCESS, counters: { done: 1, skipped: 0, errors: 0 } })
    );
    download.attachRun(['/dl/a.jpg']);
    assert.equal(download.applyLine(fileLine('/dl/a.jpg', 'skipped')).file, null);
    assert.ok(download.applyLine(fileLine('/dl/b.jpg')).file);
    assert.deepEqual(download.counters, { done: 2, skipped: 0, errors: 0 });
  });

  it('recounts known files after a restart (nothing carried over)', () => {
    const download = Download.restore(stateWith('pending'));
    download.markRunning({
      process: PROCESS,
      logFile: '/l',
      usedBrowserCookies: false,
      knownFiles: ['/dl/a.jpg'],
      now: 1
    });
    assert.ok(download.applyLine(fileLine('/dl/a.jpg', 'skipped')).file);
    assert.equal(download.counters.skipped, 1);
  });

  it('ignores lines when not running', () => {
    const download = Download.restore(stateWith('paused'));
    assert.deepEqual(download.applyLine(fileLine('/dl/a.jpg')), { changed: false, file: null });
    assert.deepEqual(download.counters, EMPTY_COUNTERS);
  });

  it('advanceLog stores only valid offsets', () => {
    const download = running();
    download.advanceLog(120);
    download.advanceLog(-1);
    download.advanceLog(Number.NaN);
    assert.equal(download.logOffset, 120);
  });
});

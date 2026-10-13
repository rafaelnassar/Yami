import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Download } from '../../domain/downloads/download.ts';
import { finishedEventShape, toConversationEvent } from './conversation-events.ts';
import { OutputPaths } from './output-paths.ts';
import { fromRecord, toRecord } from './record-mapper.ts';
import { Redactor } from './redactor.ts';

describe('OutputPaths', () => {
  const posix = new OutputPaths('linux');
  const windows = new OutputPaths('win32');

  it('resolves relative engine paths against the download dir', () => {
    assert.equal(posix.resolve('/dl', './gallery-dl/a.jpg'), '/dl/gallery-dl/a.jpg');
    assert.equal(windows.resolve('C:\\dl\\', '.\\gallery-dl\\a.jpg'), 'C:\\dl\\gallery-dl\\a.jpg');
    assert.equal(windows.resolve('C:\\dl', 'gallery-dl/a.jpg'), 'C:\\dl\\gallery-dl\\a.jpg');
    assert.equal(posix.resolve('/dl', '/abs/a.jpg'), '/abs/a.jpg');
    assert.equal(posix.engineDir('/dl/', 'yt-dlp'), '/dl/yt-dlp');
    assert.equal(windows.engineDir('C:\\dl', 'gallery-dl'), 'C:\\dl\\gallery-dl');
  });

  it('trusts only paths strictly below a root (separator boundary, no `..`)', () => {
    assert.equal(posix.isTrusted('/dl/gallery-dl/a.jpg', ['/dl']), true);
    assert.equal(posix.isTrusted('/dl', ['/dl']), false, 'the root itself is not a file');
    assert.equal(posix.isTrusted('/dlx/a.jpg', ['/dl']), false);
    assert.equal(posix.isTrusted('/etc/passwd', ['/dl']), false);
    assert.equal(posix.isTrusted('/dl/../etc/passwd', ['/dl']), false);
    assert.equal(posix.isTrusted('/dl/a\u0000.jpg', ['/dl']), false);
    assert.equal(posix.isTrusted('/DL/a.jpg', ['/dl']), false, 'case-sensitive outside Windows');
    assert.equal(posix.isTrusted('//server/dl/a.jpg', ['/dl']), false);
  });

  it('applies Windows rules: case-insensitive, both separators, no UNC/device/ADS escapes', () => {
    assert.equal(windows.isTrusted('c:/DL/yt-dlp/v.mp4', ['C:\\dl']), true);
    assert.equal(windows.isTrusted('C:\\dl\\..\\Windows\\x.dll', ['C:\\dl']), false);
    assert.equal(windows.isTrusted('\\\\attacker\\share\\a.jpg', ['C:\\dl']), false);
    assert.equal(windows.isTrusted('\\\\?\\C:\\dl\\a.jpg', ['C:\\dl']), false);
    assert.equal(windows.isTrusted('C:\\dl\\a.jpg:Zone.Identifier', ['C:\\dl']), false);
    // A UNC download dir accepts UNC paths inside it only.
    assert.equal(windows.isTrusted('\\\\nas\\media\\a.jpg', ['\\\\nas\\media']), true);
    assert.equal(windows.isTrusted('\\\\nas\\other\\a.jpg', ['\\\\nas\\media']), false);
  });

  it('checks private directories with the platform case rules', () => {
    assert.equal(posix.isInsideAny('/data/work/x/a', [null, '/data/work']), true);
    assert.equal(posix.isInsideAny('/data/workshop/a', ['/data/work']), false);
    assert.equal(posix.isInsideAny('/DATA/work/a', ['/data/work']), false);
    assert.equal(windows.isInsideAny('c:/Users/A/work/x', ['C:\\Users\\a\\WORK']), true);
  });
});

describe('record-mapper', () => {
  const download = Download.create({
    id: 'd1',
    batchId: null,
    sourceUrl: 'https://a.com/x',
    title: 'x',
    engine: 'gallery-dl',
    scope: 'single',
    cookieName: null,
    folderId: null,
    position: 1,
    now: 5
  });

  it('keeps title, folder and legacy summary owned by other use cases', () => {
    const existing = toRecord(download.toState(), null, 5);
    const renamed = { ...existing, title: 'Renamed', folderId: 'f9', legacySummary: 'old' };
    const saved = toRecord(download.toState(), renamed, 99);
    assert.equal(saved.title, 'Renamed');
    assert.equal(saved.folderId, 'f9');
    assert.equal(saved.legacySummary, 'old');
    assert.equal(saved.updatedAt, 99);
    assert.deepEqual(fromRecord(saved).status, 'pending');
  });
});

describe('conversation event mapping', () => {
  it('maps outcomes to timeline codes without null params', () => {
    const counters = { done: 2, skipped: 1, errors: 1 };
    assert.equal(finishedEventShape({ kind: 'ok', reason: null, detail: null }, counters, 'yt-dlp').code, 'completed');
    assert.equal(
      finishedEventShape({ kind: 'partial', reason: null, detail: 'x' }, counters, 'yt-dlp').level,
      'warning'
    );
    const missing = finishedEventShape({ kind: 'error', reason: 'engine-missing', detail: null }, counters, 'yt-dlp');
    assert.deepEqual(missing, {
      type: 'failed',
      level: 'error',
      code: 'failedEngineMissing',
      params: { engine: 'yt-dlp' }
    });
    const generic = finishedEventShape({ kind: 'error', reason: 'pixiv-auth', detail: null }, counters, 'gallery-dl');
    assert.deepEqual(generic.params, { reason: 'pixiv-auth', detail: '' });
    for (const reason of ['spawn-failed', 'workspace-failed', 'cookies-unavailable', 'exit-code']) {
      const shape = finishedEventShape({ kind: 'error', reason, detail: null }, counters, 'gallery-dl');
      assert.ok(
        Object.values(shape.params).every((value) => value !== null),
        reason
      );
    }
  });

  it('a partial run ended by its exit code (killed engine) says it stopped early, not "0 errors"', () => {
    const counters = { done: 50, skipped: 2, errors: 0 };
    const outcome = { kind: 'partial', reason: 'exit-code', detail: 'signal SIGKILL' } as const;
    assert.deepEqual(finishedEventShape(outcome, counters, 'gallery-dl'), {
      type: 'completed',
      level: 'warning',
      code: 'completedInterrupted',
      params: { done: 50, skipped: 2, detail: 'signal SIGKILL' }
    });
    const noDetail = finishedEventShape({ kind: 'partial', reason: 'exit-code', detail: null }, counters, 'yt-dlp');
    assert.equal(noDetail.params['detail'], '');
    const withErrors = finishedEventShape({ kind: 'partial', reason: 'not-found', detail: null }, counters, 'yt-dlp');
    assert.equal(withErrors.code, 'completedWithErrors');
  });

  it('maps pause causes and retry modes', () => {
    const paused = toConversationEvent(
      { type: 'paused', downloadId: 'd', wasRunning: false, cause: 'user', at: 1 },
      'yt-dlp'
    );
    assert.equal(paused.code, 'pausedBeforeStart');
    const exit = toConversationEvent(
      { type: 'paused', downloadId: 'd', wasRunning: true, cause: 'shutdown', at: 1 },
      'yt-dlp'
    );
    assert.equal(exit.code, 'pausedOnExit');
    const recovery = toConversationEvent(
      { type: 'paused', downloadId: 'd', wasRunning: true, cause: 'recovery', at: 1 },
      'yt-dlp'
    );
    assert.equal(recovery.code, 'pausedUnsupervised');
    const retry = toConversationEvent({ type: 'retry-scheduled', downloadId: 'd', mode: 'force', at: 3 }, 'yt-dlp');
    assert.deepEqual(retry, {
      conversationId: 'd',
      type: 'retry',
      level: 'info',
      code: 'retryWithBrowserCookies',
      params: {},
      createdAt: 3
    });
  });
});

describe('Redactor', () => {
  it('formats and redacts the engine command line', () => {
    const redactor = new Redactor(['/data/work']);
    const line = redactor.commandLine('/opt/bin/yt-dlp', [
      '--cookies',
      '/data/work/d1/c.txt',
      '-o',
      'extractor.pixiv.refresh-token=abc',
      '--paths',
      '/home/me/My Videos',
      'https://x.com/a?token=1'
    ]);
    assert.equal(
      line,
      '> yt-dlp --cookies [redacted] -o extractor.pixiv.refresh-token=[redacted] --paths "/home/me/My Videos" https://x.com/a?[redacted]'
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imageNameOf, isExitedState, parseProcStat, parsePsOutput, psArgs } from './posix-process-query.ts';

function statLine(comm: string, state: string, startTime: string): string {
  // Fields 4..21 are filler; field 22 is starttime.
  const filler = Array.from({ length: 18 }, (_, i) => String(i + 1)).join(' ');
  return `1234 (${comm}) ${state} ${filler} ${startTime} 9999 42\n`;
}

describe('parseProcStat', () => {
  it('reads field 22 after the last parenthesis even with tricky command names', () => {
    const stat = parseProcStat(statLine('yt-dlp) (evil name', 'S', '8812345'));
    assert.deepEqual(stat, { state: 'S', startTime: '8812345' });
  });

  it('rejects malformed content', () => {
    assert.equal(parseProcStat('garbage'), null);
    assert.equal(parseProcStat('12 (x) S 1 2'), null);
  });

  it('detects exited (zombie) states', () => {
    assert.equal(isExitedState('Z'), true);
    assert.equal(isExitedState('X'), true);
    assert.equal(isExitedState('S'), false);
  });
});

describe('ps (macOS)', () => {
  it('builds a batched query with pid= so rows map back to PIDs', () => {
    assert.deepEqual(psArgs([1, 22]), ['-o', 'pid=,lstart=,comm=', '-p', '1,22']);
  });

  it('parses lstart and comm (paths with spaces)', () => {
    const stdout = [
      '  501 Tue Sep 30 10:12:33 2026     /Applications/Yami.app/Contents/Resources/bin/yt-dlp',
      '12345 Wed Oct  1 09:05:07 2026     /Users/ana/Library/Application Support/Yami/runtime/python/bin/python3',
      'junk line'
    ].join('\n');
    const rows = parsePsOutput(stdout);
    assert.equal(rows.size, 2);
    assert.deepEqual(rows.get(501), {
      pid: 501,
      startToken: 'Tue Sep 30 10:12:33 2026',
      command: '/Applications/Yami.app/Contents/Resources/bin/yt-dlp'
    });
    assert.equal(rows.get(12345)?.startToken, 'Wed Oct 1 09:05:07 2026');
    assert.equal(imageNameOf(rows.get(12345)?.command ?? ''), 'python3');
  });

  it('imageNameOf handles both separators', () => {
    assert.equal(imageNameOf('C:\\Tools\\YT-DLP.EXE'), 'yt-dlp.exe');
    assert.equal(imageNameOf('/usr/bin/gallery-dl'), 'gallery-dl');
    assert.equal(imageNameOf(''), null);
  });
});

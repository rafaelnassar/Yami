import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isInsideDir, isTransientDownloadPath, looksLikePath, mediaStemOf } from './engine-paths.ts';
import { normalizeEngineLine, stripWrappingQuotes } from './line-normalizer.ts';

describe('looksLikePath', () => {
  it('accepts Windows and POSIX media paths', () => {
    assert.equal(looksLikePath('C:\\Users\\João\\Downloads\\clip.mp4'), true);
    assert.equal(looksLikePath('/home/user/out/image.jpg'), true);
    assert.equal(looksLikePath('.\\gallery-dl\\site\\01.png'), true);
  });

  it('rejects words, URLs and extension-only tokens', () => {
    assert.equal(looksLikePath('error.png'), false);
    assert.equal(looksLikePath('https://cdn.example.com/a.jpg'), false);
    assert.equal(looksLikePath('Merging formats'), false);
    assert.equal(looksLikePath(''), false);
  });

  it('accepts UNC and long-path prefixed Windows paths', () => {
    assert.equal(looksLikePath('\\\\nas\\media\\gallery-dl\\site\\01.jpg'), true);
    assert.equal(looksLikePath('\\\\?\\C:\\Users\\U\\Downloads\\a.mp4'), true);
    assert.equal(looksLikePath('\\\\?\\UNC\\nas\\media\\a.mp4'), true);
    assert.equal(looksLikePath('\\\\nas\\a.jpg'), false);
  });

  it('rejects Python warning locations and invalid Windows names', () => {
    assert.equal(looksLikePath('/usr/lib/python3/urllib3/connectionpool.py:1045: Warning see x.html'), false);
    assert.equal(looksLikePath('C:\\Python\\lib\\x.py:10: Warning: see docs.html'), false);
  });
});

describe('isTransientDownloadPath', () => {
  it('flags fragments and partials', () => {
    assert.equal(isTransientDownloadPath('C:\\Temp\\video.f137.mp4'), true);
    assert.equal(isTransientDownloadPath('C:\\Downloads\\video.mp4.part'), true);
    assert.equal(isTransientDownloadPath('C:\\Downloads\\video.mp4.ytdl'), true);
    assert.equal(isTransientDownloadPath('C:\\Downloads\\video.mp4'), false);
  });
});

describe('mediaStemOf', () => {
  it('shares one stem between fragments, partials, media and thumbnail', () => {
    assert.equal(mediaStemOf('/t/x/title [id].f137.mp4'), 'title [id]');
    assert.equal(mediaStemOf('C:\\t\\title [id].webm.part'), 'title [id]');
    assert.equal(mediaStemOf('/d/title [id].webp'), 'title [id]');
  });
});

describe('isInsideDir', () => {
  it('compares Windows paths case-insensitively with either separator', () => {
    assert.equal(isInsideDir('c:/users/u/appdata/tmp/job/x.mp4', 'C:\\Users\\U\\AppData\\Tmp\\job\\'), true);
    assert.equal(isInsideDir('C:\\Users\\U\\AppData\\Tmp\\jobs\\x.mp4', 'C:\\Users\\U\\AppData\\Tmp\\job'), false);
  });

  it('compares POSIX paths exactly and ignores relative paths', () => {
    assert.equal(isInsideDir('/tmp/job/a/x.mp4', '/tmp/job'), true);
    assert.equal(isInsideDir('/tmp/Job/a/x.mp4', '/tmp/job'), false);
    assert.equal(isInsideDir('job/a/x.mp4', '/tmp/job'), false);
    assert.equal(isInsideDir('/tmp/job/x.mp4', null), false);
  });
});

describe('normalizeEngineLine', () => {
  it('strips SGR and other escape sequences', () => {
    assert.equal(
      normalizeEngineLine('\u001b[0;31mERROR:\u001b[0m [youtube] x: Video unavailable'),
      'ERROR: [youtube] x: Video unavailable'
    );
    assert.equal(normalizeEngineLine('\u001b[2K\u001b[1G[download]  5.0%'), '[download]  5.0%');
    assert.equal(normalizeEngineLine('\u001b]0;yt-dlp 5%\u0007[info] ok'), '[info] ok');
  });

  it('keeps the last redraw of CR-only progress lines', () => {
    assert.equal(normalizeEngineLine('[download]  10.0%\r[download]  20.0%\r[download]  30.0%\r'), '[download]  30.0%');
  });

  it('normalizes to NFC', () => {
    const decomposed = 'Vi\u0301deo.mp4';
    assert.equal(normalizeEngineLine(decomposed), 'Vídeo.mp4');
    assert.equal(normalizeEngineLine(decomposed).length, 'Vídeo.mp4'.length);
  });

  it('strips one pair of wrapping quotes', () => {
    assert.equal(stripWrappingQuotes(' "D:\\Mídia\\a.mp4" '), 'D:\\Mídia\\a.mp4');
    assert.equal(stripWrappingQuotes("'x'"), 'x');
    assert.equal(stripWrappingQuotes('"'), '"');
  });
});

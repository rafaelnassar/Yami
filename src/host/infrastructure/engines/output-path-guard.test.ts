import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isReportableOutputPath } from './output-path-guard.ts';

const WIN_ROOTS = ['D:\\Yami\\yt-dlp', 'C:\\Users\\U\\AppData\\Roaming\\Yami\\work\\j1\\tmp'];
const POSIX_ROOTS = ['/home/u/Yami/gallery-dl'];

describe('isReportableOutputPath', () => {
  it('accepts paths inside a known root (either separator, Windows case-insensitive, long-path prefix)', () => {
    assert.equal(isReportableOutputPath('D:\\Yami\\yt-dlp\\youtube\\Up\\T [x].mp4', WIN_ROOTS), true);
    assert.equal(isReportableOutputPath('d:/yami/YT-DLP/youtube/a.mp4', WIN_ROOTS), true);
    assert.equal(isReportableOutputPath('\\\\?\\D:\\Yami\\yt-dlp\\a.mp4', WIN_ROOTS), true);
    assert.equal(
      isReportableOutputPath('C:\\Users\\U\\AppData\\Roaming\\Yami\\work\\j1\\tmp\\a.webm', WIN_ROOTS),
      true
    );
    assert.equal(isReportableOutputPath('/home/u/Yami/gallery-dl/pixiv/1_p0.png', POSIX_ROOTS), true);
  });

  it('rejects rooted paths outside every known root', () => {
    assert.equal(isReportableOutputPath('D:\\Yami\\yt-dlp-other\\a.mp4', WIN_ROOTS), false);
    assert.equal(isReportableOutputPath('E:\\a.mp4', WIN_ROOTS), false);
    assert.equal(isReportableOutputPath('/etc/passwd.txt', POSIX_ROOTS), false);
    assert.equal(isReportableOutputPath('/home/u/Yami/Gallery-dl/a.png', POSIX_ROOTS), false);
    assert.equal(isReportableOutputPath('C:a.mp4', WIN_ROOTS), false);
  });

  // NTLM hash leak: stat-ing \\host\share makes Windows authenticate to that host.
  it('rejects UNC, device and NT-prefixed paths unless the root is on that share', () => {
    for (const path of [
      '\\\\evil\\share\\a.mp4',
      '//evil/share/a.mp4',
      '\\\\?\\UNC\\evil\\share\\a.mp4',
      '\\??\\UNC\\evil\\share\\a.mp4',
      '\\\\.\\pipe\\x.mp4'
    ]) {
      assert.equal(isReportableOutputPath(path, WIN_ROOTS), false, path);
      assert.equal(isReportableOutputPath(path, []), false, path);
    }
    const shareRoots = ['\\\\nas\\media\\Yami\\gallery-dl'];
    assert.equal(isReportableOutputPath('\\\\NAS\\media\\Yami\\gallery-dl\\site\\01.jpg', shareRoots), true);
    assert.equal(isReportableOutputPath('\\\\?\\UNC\\nas\\media\\Yami\\gallery-dl\\01.jpg', shareRoots), true);
    assert.equal(isReportableOutputPath('\\\\evil\\media\\Yami\\gallery-dl\\01.jpg', shareRoots), false);
    assert.equal(isReportableOutputPath('\\\\nas\\media\\other\\01.jpg', shareRoots), false);
  });

  it('rejects dot segments, since lexical containment cannot hold with them', () => {
    assert.equal(isReportableOutputPath('D:\\Yami\\yt-dlp\\..\\..\\a.mp4', WIN_ROOTS), false);
    assert.equal(isReportableOutputPath('/home/u/Yami/gallery-dl/../../../x.png', POSIX_ROOTS), false);
    assert.equal(isReportableOutputPath('../x.png', POSIX_ROOTS), false);
    assert.equal(isReportableOutputPath('D:\\Yami\\yt-dlp\\.. \\a.mp4', WIN_ROOTS), false);
    assert.equal(isReportableOutputPath('/home/u/Yami/gallery-dl/./a.png', POSIX_ROOTS), true);
  });

  it('accepts plain relative paths (the core resolves them) but not drive/scheme ones', () => {
    assert.equal(isReportableOutputPath('site/u/a [1].mp4', WIN_ROOTS), true);
    assert.equal(isReportableOutputPath('.\\gallery-dl\\site\\01.png', POSIX_ROOTS), true);
    assert.equal(isReportableOutputPath('file://evil/share/a.mp4', WIN_ROOTS), false);
    assert.equal(isReportableOutputPath('file://evil/share/a.mp4', []), false);
  });

  it('without roots keeps drive and POSIX paths', () => {
    assert.equal(isReportableOutputPath('C:\\Downloads\\a.mp4', []), true);
    assert.equal(isReportableOutputPath('/d/a.mp4', [null, undefined, '']), true);
  });

  it('rejects empty paths and control characters', () => {
    assert.equal(isReportableOutputPath('', []), false);
    assert.equal(isReportableOutputPath('/home/u/Yami/gallery-dl/a\u0000.png', POSIX_ROOTS), false);
    assert.equal(isReportableOutputPath('/home/u/Yami/gallery-dl/a\t.png', POSIX_ROOTS), false);
  });
});

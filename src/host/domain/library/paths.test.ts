import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DARWIN_FLAVOR,
  POSIX_FLAVOR,
  WINDOWS_FLAVOR,
  isAbsolutePath,
  isInsideAny,
  isSameOrInside,
  joinPath,
  lastSegment,
  normalizePath,
  parentPath,
  pathFlavorFor,
  relativeSegments,
  resolveAgainst,
  samePath,
  toPosixSeparators,
  trimTrailingSeparators
} from './paths.ts';

describe('library paths', () => {
  it('picks the flavor from the platform', () => {
    assert.equal(pathFlavorFor('win32'), WINDOWS_FLAVOR);
    assert.equal(pathFlavorFor('linux'), POSIX_FLAVOR);
    // Default macOS volumes are case-insensitive.
    assert.equal(pathFlavorFor('darwin'), DARWIN_FLAVOR);
    assert.deepEqual(DARWIN_FLAVOR, { separator: '/', caseInsensitive: true });
  });

  it('detects absolute paths of every platform', () => {
    assert.ok(isAbsolutePath('/home/a'));
    assert.ok(isAbsolutePath('C:\\Users'));
    assert.ok(isAbsolutePath('c:/Users'));
    assert.ok(isAbsolutePath('\\\\server\\share'));
    assert.ok(isAbsolutePath('\\rooted'));
    assert.ok(!isAbsolutePath('gallery-dl/site'));
    assert.ok(!isAbsolutePath('C:relative'));
    assert.ok(!isAbsolutePath('.\\a.jpg'));
  });

  it('applies the flavor syntax to absolute paths when given', () => {
    assert.ok(isAbsolutePath('C:\\x', WINDOWS_FLAVOR));
    assert.ok(isAbsolutePath('//srv/share', WINDOWS_FLAVOR));
    assert.ok(isAbsolutePath('/x', POSIX_FLAVOR));
    // On POSIX these are ordinary relative names.
    assert.ok(!isAbsolutePath('C:\\x', POSIX_FLAVOR));
    assert.ok(!isAbsolutePath('\\x', POSIX_FLAVOR));
  });

  describe('normalizePath', () => {
    it('normalizes Windows separators, duplicates, dots and case-preserving drive roots', () => {
      assert.equal(normalizePath('c:/a//b/', WINDOWS_FLAVOR), 'c:\\a\\b');
      assert.equal(normalizePath('C:\\a\\.\\b\\..\\c', WINDOWS_FLAVOR), 'C:\\a\\c');
      assert.equal(normalizePath('C:\\a\\..\\..\\..', WINDOWS_FLAVOR), 'C:\\');
      assert.equal(normalizePath('C:/', WINDOWS_FLAVOR), 'C:\\');
      assert.equal(normalizePath('\\a\\..\\..\\b', WINDOWS_FLAVOR), '\\b');
      assert.equal(normalizePath('C:a\\..\\..\\b', WINDOWS_FLAVOR), 'C:..\\b');
    });

    it('keeps UNC shares as roots', () => {
      assert.equal(normalizePath('\\\\srv\\share\\', WINDOWS_FLAVOR), '\\\\srv\\share');
      assert.equal(normalizePath('//srv/share/x/../..', WINDOWS_FLAVOR), '\\\\srv\\share');
      assert.equal(normalizePath('\\\\srv\\share\\\\a/b\\', WINDOWS_FLAVOR), '\\\\srv\\share\\a\\b');
    });

    it('normalizes POSIX paths and treats backslashes as file-name characters', () => {
      assert.equal(normalizePath('//a//b/', POSIX_FLAVOR), '/a/b');
      assert.equal(normalizePath('/a/../../b', POSIX_FLAVOR), '/b');
      assert.equal(normalizePath('./x', POSIX_FLAVOR), 'x');
      assert.equal(normalizePath('../a/./b', POSIX_FLAVOR), '../a/b');
      assert.equal(normalizePath('a\\b', POSIX_FLAVOR), 'a\\b');
      assert.equal(normalizePath('a/..', POSIX_FLAVOR), '');
      assert.equal(normalizePath('/', POSIX_FLAVOR), '/');
    });
  });

  it('joins with the platform separator', () => {
    assert.equal(joinPath('/dl/', 'gallery-dl/site', POSIX_FLAVOR), '/dl/gallery-dl/site');
    assert.equal(joinPath('C:\\dl', 'gallery-dl/site', WINDOWS_FLAVOR), 'C:\\dl\\gallery-dl\\site');
    assert.equal(joinPath('C:\\', 'x', WINDOWS_FLAVOR), 'C:\\x');
    assert.equal(joinPath('/', 'x', POSIX_FLAVOR), '/x');
    assert.equal(joinPath('/dl', '', POSIX_FLAVOR), '/dl');
    assert.equal(joinPath('\\\\srv\\share', 'a/b', WINDOWS_FLAVOR), '\\\\srv\\share\\a\\b');
  });

  it('treats the child as relative and resolves dots lexically when joining', () => {
    assert.equal(joinPath('/dl', '/x', POSIX_FLAVOR), '/dl/x');
    assert.equal(joinPath('C:\\dl', '\\\\x', WINDOWS_FLAVOR), 'C:\\dl\\x');
    assert.equal(joinPath('/dl', './a/../b', POSIX_FLAVOR), '/dl/b');
    // Escapes are resolved, so callers can check containment on the result.
    assert.equal(joinPath('/dl', '../etc', POSIX_FLAVOR), '/etc');
    assert.equal(joinPath('', 'a/b', POSIX_FLAVOR), 'a/b');
  });

  it('resolves engine-printed relative paths against a directory', () => {
    assert.equal(resolveAgainst('/dl', './gallery-dl/a.jpg', POSIX_FLAVOR), '/dl/gallery-dl/a.jpg');
    assert.equal(resolveAgainst('C:\\dl\\', '.\\gallery-dl\\a.jpg', WINDOWS_FLAVOR), 'C:\\dl\\gallery-dl\\a.jpg');
    assert.equal(resolveAgainst('C:\\dl', 'gallery-dl/a.jpg', WINDOWS_FLAVOR), 'C:\\dl\\gallery-dl\\a.jpg');
    assert.equal(resolveAgainst('/dl', '/abs/a.jpg', POSIX_FLAVOR), '/abs/a.jpg');
    assert.equal(resolveAgainst('C:\\dl', 'D:/x//a.jpg', WINDOWS_FLAVOR), 'D:\\x\\a.jpg');
    assert.equal(resolveAgainst('C:\\dl', '\\\\nas\\media\\a.jpg', WINDOWS_FLAVOR), '\\\\nas\\media\\a.jpg');
    assert.equal(resolveAgainst('', 'a.jpg', POSIX_FLAVOR), 'a.jpg');
    // A backslash name is relative on POSIX.
    assert.equal(resolveAgainst('/dl', '\\x.jpg', POSIX_FLAVOR), '/dl/\\x.jpg');
  });

  it('computes parents without leaving the root', () => {
    assert.equal(parentPath('/a/b', POSIX_FLAVOR), '/a');
    assert.equal(parentPath('/a/b/', POSIX_FLAVOR), '/a');
    assert.equal(parentPath('/a', POSIX_FLAVOR), '/');
    assert.equal(parentPath('/', POSIX_FLAVOR), '/');
    assert.equal(parentPath('C:\\a\\b', WINDOWS_FLAVOR), 'C:\\a');
    assert.equal(parentPath('C:/a', WINDOWS_FLAVOR), 'C:\\');
    assert.equal(parentPath('C:\\', WINDOWS_FLAVOR), 'C:\\');
    assert.equal(parentPath('name', POSIX_FLAVOR), '');
  });

  it('stops UNC parents at the share', () => {
    assert.equal(parentPath('\\\\srv\\share\\a\\b', WINDOWS_FLAVOR), '\\\\srv\\share\\a');
    assert.equal(parentPath('\\\\srv\\share\\a', WINDOWS_FLAVOR), '\\\\srv\\share');
    assert.equal(parentPath('\\\\srv\\share', WINDOWS_FLAVOR), '\\\\srv\\share');
    assert.equal(parentPath('//srv/share/', WINDOWS_FLAVOR), '\\\\srv\\share');
  });

  it('trims trailing separators but keeps roots', () => {
    assert.equal(trimTrailingSeparators('/a/b//'), '/a/b');
    assert.equal(trimTrailingSeparators('/'), '/');
    assert.equal(trimTrailingSeparators('C:\\'), 'C:\\');
    assert.equal(trimTrailingSeparators('\\\\srv\\share\\'), '\\\\srv\\share');
  });

  describe('comparisons', () => {
    it('compares paths with the platform case rule', () => {
      assert.ok(samePath('C:\\DL\\Foo', 'c:/dl/foo/', WINDOWS_FLAVOR));
      assert.ok(!samePath('/dl/Foo', '/dl/foo', POSIX_FLAVOR));
      assert.ok(samePath('/dl/Foo', '/dl/foo', DARWIN_FLAVOR));
      assert.ok(samePath('/dl/foo/', '/dl/foo', POSIX_FLAVOR));
    });

    it('ignores duplicate separators and dot segments', () => {
      assert.ok(samePath('/dl//a/./b', '/dl/a/b', POSIX_FLAVOR));
      assert.ok(samePath('C:\\dl\\x\\..\\a', 'c:/DL/a', WINDOWS_FLAVOR));
    });

    it('distinguishes roots', () => {
      assert.ok(!samePath('C:\\dl', 'D:\\dl', WINDOWS_FLAVOR));
      assert.ok(!samePath('\\dl', 'C:\\dl', WINDOWS_FLAVOR));
      assert.ok(!samePath('/dl', 'dl', POSIX_FLAVOR));
      assert.ok(samePath('\\\\SRV\\Share\\a', '//srv/share/A', WINDOWS_FLAVOR));
      assert.ok(!samePath('\\\\srv\\share1\\a', '\\\\srv\\share2\\a', WINDOWS_FLAVOR));
    });

    it('uses a separator boundary for containment', () => {
      assert.deepEqual(relativeSegments('/dl/foo', '/dl/foo/a/b', POSIX_FLAVOR), ['a', 'b']);
      assert.deepEqual(relativeSegments('/dl/foo', '/dl/foo', POSIX_FLAVOR), []);
      assert.equal(relativeSegments('/dl/foo', '/dl/foobar/a', POSIX_FLAVOR), null);
      assert.deepEqual(relativeSegments('C:\\DL', 'c:\\dl\\Gallery-DL', WINDOWS_FLAVOR), ['Gallery-DL']);
      assert.deepEqual(relativeSegments('/', '/a', POSIX_FLAVOR), ['a']);
      assert.deepEqual(relativeSegments('C:\\', 'c:/a/B', WINDOWS_FLAVOR), ['a', 'B']);
      assert.ok(isSameOrInside('/dl', '/dl/x', POSIX_FLAVOR));
      assert.ok(!isSameOrInside('/dl', '/other', POSIX_FLAVOR));
      assert.ok(!isSameOrInside('/data/work', '/DATA/work/a', POSIX_FLAVOR));
      assert.ok(isSameOrInside('C:\\Users\\a\\WORK', 'c:/Users/A/work/x', WINDOWS_FLAVOR));
    });

    it('never treats a `..` escape as inside', () => {
      assert.equal(relativeSegments('/dl', '/dl/../etc/passwd', POSIX_FLAVOR), null);
      assert.equal(relativeSegments('C:\\dl', 'C:\\dl\\..\\Windows', WINDOWS_FLAVOR), null);
      assert.deepEqual(relativeSegments('/dl', '/dl/a/../b', POSIX_FLAVOR), ['b']);
    });

    it('checks containment inside UNC shares', () => {
      assert.deepEqual(relativeSegments('\\\\nas\\media', '//NAS/Media/dl/a.jpg', WINDOWS_FLAVOR), ['dl', 'a.jpg']);
      assert.equal(relativeSegments('\\\\nas\\media\\dl', '\\\\nas\\media\\dl2', WINDOWS_FLAVOR), null);
      assert.equal(relativeSegments('\\\\nas\\media', '\\\\nas\\mediax\\a', WINDOWS_FLAVOR), null);
    });

    it('checks containment against several roots', () => {
      const roots = ['/app/data', '', '/tmp/job-1'];
      assert.ok(isInsideAny(roots, '/app/data/cookies.txt', POSIX_FLAVOR));
      assert.ok(isInsideAny(roots, '/tmp/job-1', POSIX_FLAVOR));
      assert.ok(!isInsideAny(roots, '/dl/a.jpg', POSIX_FLAVOR));
      assert.ok(!isInsideAny(roots, 'relative.jpg', POSIX_FLAVOR));
      assert.ok(isInsideAny(['C:\\App'], 'c:/app/Secrets/x', WINDOWS_FLAVOR));
      assert.ok(!isInsideAny([], '/x', POSIX_FLAVOR));
    });
  });

  it('extracts the last segment and converts separators', () => {
    assert.equal(lastSegment('C:\\dl\\album\\'), 'album');
    assert.equal(lastSegment('/dl/x.jpg'), 'x.jpg');
    assert.equal(lastSegment('/'), '');
    assert.equal(toPosixSeparators('a\\b\\c'), 'a/b/c');
  });
});

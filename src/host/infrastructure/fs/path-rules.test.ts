import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasAlternateDataStream,
  isAmbiguousWindowsPath,
  isDiskRoot,
  isFullyQualified,
  isInsideOrEqual,
  isWindowsReservedName,
  syntaxProblem
} from './path-rules.ts';

describe('Windows reserved names (ported)', () => {
  it('rejects CON, PRN, AUX, NUL, COM*, LPT* (with extensions / trailing spaces)', () => {
    for (const name of [
      'CON',
      'prn',
      'Aux',
      'nul.txt',
      'COM1',
      'com9.log',
      'LPT1',
      'lpt9',
      'COM0',
      'con .txt',
      'CONIN$',
      'lpt¹'
    ]) {
      assert.equal(isWindowsReservedName(name), true, name);
    }
  });

  it('allows ordinary names', () => {
    for (const name of ['video.mp4', 'console.txt', '', 'com10', 'nulled.jpg']) {
      assert.equal(isWindowsReservedName(name), false, name);
    }
  });
});

describe('ADS (ported)', () => {
  it('detects alternate data streams and keeps drive letters', () => {
    assert.equal(hasAlternateDataStream('C:\\dl\\file.txt:zone.identifier'), true);
    assert.equal(hasAlternateDataStream('file.txt:hidden'), true);
    assert.equal(hasAlternateDataStream('C:\\dl\\file.txt'), false);
    assert.equal(hasAlternateDataStream('C:/dl/file.txt'), false);
  });

  it('only applies on Windows (":" is a legal POSIX file name character — legacy quirk)', () => {
    assert.equal(syntaxProblem('C:\\dl\\clip.mp4:secret', 'win32'), 'ads');
    assert.equal(syntaxProblem('/dl/Re: talk 10:30.mp4', 'linux'), null);
  });
});

describe('syntaxProblem', () => {
  it('rejects NUL / control characters on every platform', () => {
    assert.equal(syntaxProblem('inside\0.txt', 'linux'), 'control-chars');
    assert.equal(syntaxProblem('a\nb', 'darwin'), 'control-chars');
    assert.equal(syntaxProblem('', 'linux'), 'empty');
  });

  it('rejects \\\\?\\, \\\\.\\ and \\??\\ prefixes', () => {
    for (const input of [
      '\\\\?\\C:\\dl\\x.mp4',
      '\\\\.\\PhysicalDrive0',
      '//?/C:/dl',
      '\\??\\C:\\dl',
      '\\\\?\\UNC\\srv\\share'
    ]) {
      assert.equal(syntaxProblem(input, 'win32'), 'device-prefix', input);
    }
  });

  it('rejects reserved names in ANY segment and trailing dots/spaces on Windows', () => {
    assert.equal(syntaxProblem('C:\\dl\\nul\\x.mp4', 'win32'), 'reserved-name');
    assert.equal(syntaxProblem('C:\\dl\\x\\COM1.txt', 'win32'), 'reserved-name');
    assert.equal(syntaxProblem('C:\\AppData\\Yami.\\x', 'win32'), 'invalid-name');
    assert.equal(syntaxProblem('C:\\dl\\a|b', 'win32'), 'invalid-name');
    assert.equal(syntaxProblem('C:\\dl\\..\\x.mp4', 'win32'), null);
    assert.equal(syntaxProblem('/dl/nul/x', 'linux'), null);
  });
});

describe('isInsideOrEqual', () => {
  it('contains children, the root itself and names starting with ".." (legacy quirk)', () => {
    assert.equal(isInsideOrEqual('/dl', '/dl', 'linux'), true);
    assert.equal(isInsideOrEqual('/dl', '/dl/a/b.mp4', 'linux'), true);
    assert.equal(isInsideOrEqual('/dl', '/dl/..hidden', 'linux'), true);
    assert.equal(isInsideOrEqual('/dl', '/dl-other/x', 'linux'), false);
    assert.equal(isInsideOrEqual('/dl', '/x', 'linux'), false);
  });

  it('is case-insensitive on Windows only', () => {
    assert.equal(isInsideOrEqual('C:\\Users\\Ana\\Yami', 'c:\\USERS\\ana\\yami\\x.jpg', 'win32'), true);
    assert.equal(isInsideOrEqual('/Users/ana/Yami', '/users/ana/yami/x.jpg', 'linux'), false);
    assert.equal(isInsideOrEqual('C:\\dl', 'D:\\dl\\x', 'win32'), false);
  });
});

describe('roots and absoluteness', () => {
  it('detects disk roots', () => {
    assert.equal(isDiskRoot('/', 'linux'), true);
    assert.equal(isDiskRoot('C:\\', 'win32'), true);
    assert.equal(isDiskRoot('c:/', 'win32'), true);
    assert.equal(isDiskRoot('\\\\server\\share', 'win32'), true);
    assert.equal(isDiskRoot('C:\\dl', 'win32'), false);
  });

  it('only accepts fully-qualified Windows paths', () => {
    assert.equal(isFullyQualified('C:\\dl', 'win32'), true);
    assert.equal(isFullyQualified('\\\\server\\share\\dl', 'win32'), true);
    assert.equal(isFullyQualified('C:dl', 'win32'), false);
    assert.equal(isFullyQualified('\\dl', 'win32'), false);
    assert.equal(isAmbiguousWindowsPath('C:dl', 'win32'), true);
    assert.equal(isAmbiguousWindowsPath('\\dl', 'win32'), true);
    assert.equal(isAmbiguousWindowsPath('sub\\x.mp4', 'win32'), false);
  });
});

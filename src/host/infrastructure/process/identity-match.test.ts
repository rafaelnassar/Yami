import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';
import { identityMatches, imageNamesMatch } from './identity-match.ts';
import type { ProcessSnapshot } from './process-snapshot.ts';

function identity(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    pid: 4242,
    imageName: 'yt-dlp.exe',
    startToken: '2026-09-30T13:12:33.123Z',
    startTokenSource: 'powershell',
    executable: 'C:\\bin\\yt-dlp.exe',
    capturedAt: 1,
    ...overrides
  };
}

function snapshot(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    pid: 4242,
    imageName: 'yt-dlp.exe',
    startToken: '2026-09-30T13:12:33.123Z',
    startTokenSource: 'powershell',
    executablePath: null,
    ...overrides
  };
}

describe('identityMatches', () => {
  it('matches the same process', () => {
    assert.equal(identityMatches(identity(), snapshot(), 'win32'), true);
  });

  it('compares image names case-insensitively', () => {
    assert.equal(identityMatches(identity({ imageName: 'YT-DLP.EXE' }), snapshot(), 'win32'), true);
    assert.equal(identityMatches(identity(), snapshot({ imageName: 'notepad.exe' }), 'win32'), false);
  });

  it('detects PID reuse through a different start token from the same source', () => {
    assert.equal(identityMatches(identity(), snapshot({ startToken: '2026-09-30T14:00:00.000Z' }), 'win32'), false);
  });

  it('treats tokens from a different source as unknown (legacy wmic → PowerShell)', () => {
    const legacy = identity({ startToken: '20260930101233.123456-180', startTokenSource: 'wmic' });
    assert.equal(identityMatches(legacy, snapshot(), 'win32'), true);
    const noSource = identity({ startToken: 'whatever', startTokenSource: null });
    assert.equal(identityMatches(noSource, snapshot(), 'win32'), true);
  });

  it('does not compare legacy PowerShell tick tokens with normalized CreationDate tokens', () => {
    const legacyTicks = identity({ startToken: '638632123451234567', startTokenSource: 'powershell' });
    assert.equal(identityMatches(legacyTicks, snapshot(), 'win32'), true);
  });

  it('treats missing data as a match', () => {
    const current = snapshot({ imageName: null, startToken: null, startTokenSource: null });
    assert.equal(identityMatches(identity(), current, 'win32'), true);
  });

  it('requires the same PID', () => {
    assert.equal(identityMatches(identity(), snapshot({ pid: 1 }), 'win32'), false);
  });
});

describe('imageNamesMatch', () => {
  it('accepts the 15-char truncation of /proc/<pid>/comm on Linux only', () => {
    assert.equal(imageNamesMatch('gallery-dl-nightly', 'gallery-dl-nigh', 'linux'), true);
    assert.equal(imageNamesMatch('gallery-dl-nightly', 'gallery-dl-nigh', 'darwin'), false);
    assert.equal(imageNamesMatch('yt-dlp', 'python3', 'linux'), false);
  });
});

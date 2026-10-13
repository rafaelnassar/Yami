import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions, extractVersionToken, isNewer, newestOf, normalizeTag, versionScheme } from './versions.ts';

describe('runtime versions', () => {
  it('normalizes GitHub tags', () => {
    assert.equal(normalizeTag(' v2.5.6 '), '2.5.6');
    assert.equal(normalizeTag('V2026.08.19'), '2026.08.19');
    assert.equal(normalizeTag('2025.11.12'), '2025.11.12');
  });

  it('detects date and semver schemes', () => {
    assert.equal(versionScheme('2025.11.12'), 'date');
    assert.equal(versionScheme('v2026.08.19'), 'date');
    assert.equal(versionScheme('1.32.9'), 'semver');
    assert.equal(versionScheme('7.1'), 'semver');
    assert.equal(versionScheme('N-12345-gabc'), 'unknown');
  });

  it('extracts the comparable token from noisy --version output', () => {
    assert.equal(extractVersionToken('deno 2.5.6 (stable, release, x86_64-pc-windows-msvc)'), '2.5.6');
    assert.equal(
      extractVersionToken('ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2025'),
      '7.1.1'
    );
    assert.equal(extractVersionToken('Python 3.12.14'), '3.12.14');
    assert.equal(extractVersionToken('2025.11.12'), '2025.11.12');
    assert.equal(extractVersionToken('2025.11.12.232846'), '2025.11.12.232846');
    assert.equal(extractVersionToken('ffmpeg version 2025-03-31-git-35c091f4b7-essentials_build'), null);
    assert.equal(extractVersionToken(''), null);
    assert.equal(extractVersionToken(null), null);
  });

  it('compares dotted versions of the same scheme', () => {
    assert.ok(isNewer('1.27.7', '1.27.6'));
    assert.ok(isNewer('2025.10.14', '2025.09.01'));
    assert.ok(isNewer('1.32.10', '1.32.9'));
    assert.ok(isNewer('2.5', '2.4.9'));
    assert.ok(isNewer('2025.11.12.1', '2025.11.12'));
    assert.equal(isNewer('1.0.0', '1.0.0'), false);
    assert.equal(isNewer('1.0', '1.0.0'), false);
    assert.equal(compareVersions('2.10.0', '2.9.9') !== null && (compareVersions('2.10.0', '2.9.9') ?? 0) > 0, true);
  });

  it('never compares date builds with semver releases', () => {
    assert.equal(isNewer('2026.08.19', '1.32.9'), false);
    assert.equal(isNewer('1.32.9', '2026.08.19'), false);
    assert.equal(compareVersions('2026.08.19', '1.32.9'), null);
    assert.equal(isNewer('2026.08.20', '2026.08.19'), true);
  });

  it('treats missing or unknown versions as not newer', () => {
    assert.equal(isNewer(null, '1.0'), false);
    assert.equal(isNewer('1.0', null), false);
    assert.equal(isNewer('abc', 'abd'), false);
  });

  it('picks the newest comparable version', () => {
    assert.equal(newestOf('2025.11.12', '2026.01.02'), '2026.01.02');
    assert.equal(newestOf('2025.11.12', '2025.01.02'), '2025.11.12');
    assert.equal(newestOf('2025.11.12', null), '2025.11.12');
    assert.equal(newestOf('2025.11.12', '9.9.9'), '2025.11.12');
  });
});

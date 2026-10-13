import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lockMismatch, mergeLocks, normalizePackageName, normalizeVersion, requirementName } from './python-lock.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('python locks', () => {
  it('normalizes names like PEP 503 and strips extras', () => {
    assert.equal(normalizePackageName('Charset_Normalizer'), 'charset-normalizer');
    assert.equal(normalizePackageName('zope..interface'), 'zope-interface');
    assert.equal(requirementName('yt-dlp[default]'), 'yt-dlp');
    assert.equal(requirementName('gallery-dl'), 'gallery-dl');
    assert.equal(normalizeVersion('2026.01.05'), '2026.1.5');
    assert.equal(normalizeVersion('1.0RC1'), '1.0rc1');
  });

  it('merges shared dependencies once (digests united) and reports version conflicts', () => {
    const merged = mergeLocks([
      [
        { name: 'gallery-dl', version: '1.32.9', sha256: [A] },
        { name: 'requests', version: '2.32.5', sha256: [A] }
      ],
      [
        { name: 'Requests', version: '2.32.5', sha256: [A, B] },
        { name: 'yt-dlp', version: '2025.11.12', sha256: [B] }
      ]
    ]);
    assert.deepEqual(merged.ok ? merged.value : null, [
      { name: 'gallery-dl', version: '1.32.9', sha256: [A] },
      { name: 'requests', version: '2.32.5', sha256: [A, B] },
      { name: 'yt-dlp', version: '2025.11.12', sha256: [B] }
    ]);
    const conflict = mergeLocks([
      [{ name: 'requests', version: '2.32.4', sha256: [A] }],
      [{ name: 'requests', version: '2.32.5', sha256: [B] }]
    ]);
    assert.deepEqual(conflict.ok ? null : conflict.error, { name: 'requests', versions: ['2.32.4', '2.32.5'] });
  });

  it('checks that a lock pins exactly the manifest version once', () => {
    const lock = [
      { name: 'yt_dlp', version: '2025.11.12', sha256: [A] },
      { name: 'brotli', version: '1.1.0', sha256: [B] }
    ];
    assert.equal(lockMismatch(lock, 'yt-dlp[default]', '2025.11.12'), null);
    assert.equal(lockMismatch([{ name: 'yt-dlp', version: '2026.1.15', sha256: [A] }], 'yt-dlp', '2026.01.15'), null);
    assert.equal(lockMismatch(lock, 'yt-dlp[default]', '2026.01.15'), 'locks yt-dlp==2025.11.12, pinned 2026.01.15');
    assert.equal(lockMismatch(lock, 'gallery-dl', '1.32.9'), 'does not lock gallery-dl');
    assert.equal(
      lockMismatch([...lock, { name: 'Brotli', version: '1.1.0', sha256: [A] }], 'yt-dlp', '2025.11.12'),
      'duplicate package brotli'
    );
  });
});

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import { unwrap } from '../../../shared/kernel/result.ts';
import { makeTempDir } from '../persistence/test-fixtures.ts';
import { writeFileAtomic } from './atomic-file.ts';
import { SecretBox } from './secret-box.ts';
import { testKey } from './test-fixtures.ts';

describe('SecretBox', () => {
  it('round-trips data with the YV1 header layout', () => {
    const box = unwrap(SecretBox.fromBase64(testKey()));
    const blob = box.encrypt('segredo 🔑', 'label');
    assert.equal(blob.subarray(0, 3).toString('ascii'), 'YV1');
    assert.equal(blob.length, 3 + 12 + 16 + Buffer.byteLength('segredo 🔑'));
    assert.equal(unwrap(box.decrypt(blob, 'label')).toString('utf8'), 'segredo 🔑');
    assert.notDeepEqual(box.encrypt('same'), box.encrypt('same'), 'random IV per message');
  });

  it('validates the key', () => {
    assert.equal(SecretBox.fromBase64(randomBytes(16).toString('base64')).ok, false);
    assert.equal(SecretBox.fromBase64('not base64 !!').ok, false);
    const result = SecretBox.fromBase64(randomBytes(31).toString('base64'));
    assert.equal(result.ok ? null : result.error.code, ErrorCode.VAULT_UNAVAILABLE);
  });

  it('detects tampering, wrong keys, wrong labels and foreign formats', () => {
    const box = unwrap(SecretBox.fromBase64(testKey()));
    const blob = box.encrypt('payload', 'a');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0x01;
    const failures = [
      box.decrypt(tampered, 'a'),
      unwrap(SecretBox.fromBase64(testKey())).decrypt(blob, 'a'),
      box.decrypt(blob, 'b'),
      box.decrypt(blob),
      box.decrypt(Buffer.from('plain text file'), 'a'),
      box.decrypt(blob.subarray(0, 20), 'a')
    ];
    for (const result of failures) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, ErrorCode.VAULT_UNAVAILABLE);
    }
  });
});

describe('writeFileAtomic', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = makeTempDir('yami-atomic-')));
  afterEach(() => cleanup());

  it('writes with 0600, replaces existing content and leaves no temp files', async () => {
    const file = path.join(dir, 'nested', 'secret.bin');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, Buffer.from('two'));
    assert.equal(readFileSync(file, 'utf8'), 'two');
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    assert.deepEqual(readdirSync(path.dirname(file)), ['secret.bin']);
  });

  it('narrows the mode of a replaced world-readable file', async () => {
    if (process.platform === 'win32') return;
    const file = path.join(dir, 'x');
    writeFileSync(file, 'old', { mode: 0o644 });
    await writeFileAtomic(file, 'new');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

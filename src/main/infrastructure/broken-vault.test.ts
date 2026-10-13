import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, it, mock } from 'node:test';
import { brokenSuffix, moveVaultAsideSync } from './broken-vault.ts';
import { nullLogger } from './logger.ts';

const root = fs.mkdtempSync(path.join(tmpdir(), 'yami-broken-vault-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const NOW = Date.UTC(2026, 8, 30, 12, 34, 56, 789);

function vaultIn(name: string): { vaultDir: string; keyFile: string } {
  const vaultDir = path.join(root, name, 'data', 'vault');
  fs.mkdirSync(path.join(vaultDir, 'cookies'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'key.bin'), 'old-key');
  fs.writeFileSync(path.join(vaultDir, 'cookies', 'site.txt.enc'), 'sealed');
  return { vaultDir, keyFile: path.join(vaultDir, 'key.bin') };
}

describe('moveVaultAsideSync', () => {
  it('renames the vault (with key.bin inside) to vault.broken-<timestamp>, deleting nothing', () => {
    const location = vaultIn('a');
    const moved = moveVaultAsideSync(location, NOW, nullLogger);
    const expected = `${location.vaultDir}.broken-2026-09-30T12-34-56-789Z`;
    assert.deepEqual(moved, { ok: true, value: [expected] });
    assert.equal(fs.existsSync(location.vaultDir), false);
    assert.equal(fs.readFileSync(path.join(expected, 'key.bin'), 'utf8'), 'old-key');
    assert.equal(fs.readFileSync(path.join(expected, 'cookies', 'site.txt.enc'), 'utf8'), 'sealed');
  });

  it('never reuses the name of an earlier reset', () => {
    const location = vaultIn('b');
    assert.ok(moveVaultAsideSync(location, NOW, nullLogger).ok);
    vaultIn('b');
    const second = moveVaultAsideSync(location, NOW, nullLogger);
    assert.deepEqual(second, { ok: true, value: [`${location.vaultDir}${brokenSuffix(NOW)}-2`] });
    assert.equal(fs.readdirSync(path.dirname(location.vaultDir)).length, 2);
  });

  it('also moves a key file kept outside the vault, and reports nothing to move', () => {
    const location = { vaultDir: path.join(root, 'c', 'vault'), keyFile: path.join(root, 'c', 'key.bin') };
    fs.mkdirSync(location.vaultDir, { recursive: true });
    fs.writeFileSync(location.keyFile, 'k');
    const moved = moveVaultAsideSync(location, NOW, nullLogger);
    assert.deepEqual(moved, {
      ok: true,
      value: [`${location.vaultDir}${brokenSuffix(NOW)}`, `${location.keyFile}${brokenSuffix(NOW)}`]
    });
    assert.deepEqual(moveVaultAsideSync(location, NOW, nullLogger), { ok: true, value: [] });
  });

  it('fails without touching anything when the rename is refused', () => {
    const location = vaultIn('d');
    mock.method(fs, 'renameSync', () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    const moved = moveVaultAsideSync(location, NOW, nullLogger);
    assert.deepEqual(moved, { ok: false, error: { code: 'FILE_OPERATION_FAILED', params: { detail: 'EACCES' } } });
    assert.equal(fs.readFileSync(location.keyFile, 'utf8'), 'old-key');
  });
});

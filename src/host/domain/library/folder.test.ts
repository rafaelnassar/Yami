import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../../../shared/kernel/errors.ts';
import {
  DEFAULT_FOLDER_COLOR,
  applyFolderPatch,
  createFolder,
  sanitizeImportedFolderColor,
  sanitizeImportedFolderName,
  validateFolderName
} from './folder.ts';

const base = { id: 'f1', name: ' Artists ', color: '#a1b2c3', position: 3, createdAt: 10 };

describe('sidebar folder rules', () => {
  it('creates a folder with trimmed name and upper-case color', () => {
    const result = createFolder(base);
    assert.ok(result.ok);
    assert.deepEqual(result.value, {
      id: 'f1',
      name: 'Artists',
      color: '#A1B2C3',
      collapsed: false,
      position: 3,
      createdAt: 10
    });
  });

  it('validates name length, color and position', () => {
    const tooLong = createFolder({ ...base, name: 'x'.repeat(81) });
    assert.ok(!tooLong.ok && tooLong.error.code === ErrorCode.FOLDER_NAME_INVALID);
    const blank = createFolder({ ...base, name: '   ' });
    assert.ok(!blank.ok && blank.error.code === ErrorCode.FOLDER_NAME_INVALID);
    const color = createFolder({ ...base, color: 'red' });
    assert.ok(!color.ok && color.error.code === ErrorCode.VALIDATION_FAILED);
    const position = createFolder({ ...base, position: -1 });
    assert.ok(!position.ok && position.error.params?.['path'] === 'position');
    assert.ok(validateFolderName('x'.repeat(80)).ok);
    assert.ok(!validateFolderName('a\nb').ok);
  });

  it('applies partial patches and keeps untouched fields', () => {
    const folder = createFolder(base);
    assert.ok(folder.ok);
    const patched = applyFolderPatch(folder.value, { collapsed: true, position: 0 });
    assert.ok(patched.ok);
    assert.equal(patched.value.name, 'Artists');
    assert.equal(patched.value.collapsed, true);
    assert.equal(patched.value.position, 0);
    const invalid = applyFolderPatch(folder.value, { name: '' });
    assert.ok(!invalid.ok && invalid.error.code === ErrorCode.FOLDER_NAME_INVALID);
  });

  it('sanitizes legacy names and colors', () => {
    assert.equal(sanitizeImportedFolderName('  a\u0000b   c '), 'a b c');
    assert.equal(sanitizeImportedFolderName('\u0001 '), null);
    assert.equal(sanitizeImportedFolderName('y'.repeat(200))?.length, 80);
    assert.equal(sanitizeImportedFolderColor('#abcdef'), '#ABCDEF');
    assert.equal(sanitizeImportedFolderColor('blue'), DEFAULT_FOLDER_COLOR);
  });
});

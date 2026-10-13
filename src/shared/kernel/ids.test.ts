import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from './ids.ts';

describe('shared/kernel/ids', () => {
  it('returns a time-prefixed unique id', () => {
    const a = newId();
    const b = newId('c');
    assert.match(a, /^[a-z0-9]+-[a-f0-9]{12}$/);
    assert.match(b, /^c[a-z0-9]+-[a-f0-9]{12}$/);
    assert.notEqual(a, b.slice(1));
  });
});

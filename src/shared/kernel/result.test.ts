import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { err, isErr, isOk, mapResult, ok, unwrap } from './result.ts';

describe('shared/kernel/result', () => {
  it('builds ok and err', () => {
    assert.deepEqual(ok(1), { ok: true, value: 1 });
    assert.deepEqual(err('x'), { ok: false, error: 'x' });
    assert.equal(ok().ok, true);
  });

  it('narrows with isOk / isErr', () => {
    const success = ok('a');
    const failure = err(2);
    assert.equal(isOk(success), true);
    assert.equal(isErr(success), false);
    assert.equal(isOk(failure), false);
    assert.equal(isErr(failure), true);
  });

  it('maps only success values', () => {
    assert.deepEqual(
      mapResult(ok(2), (n) => n * 3),
      ok(6)
    );
    assert.deepEqual(
      mapResult(err('no'), (n: number) => n * 3),
      err('no')
    );
  });

  it('unwraps success and throws on error', () => {
    assert.equal(unwrap(ok(9)), 9);
    assert.throws(() => unwrap(err(new Error('boom'))), /boom/);
    assert.throws(() => unwrap(err({ code: 'X' })), /"code":"X"/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, ErrorCode, appError, isAppErrorData, isErrorCode, toAppErrorData } from './errors.ts';

describe('shared/kernel/errors', () => {
  it('builds AppErrorData with and without params', () => {
    assert.deepEqual(appError(ErrorCode.INTERNAL), { code: ErrorCode.INTERNAL });
    assert.deepEqual(appError(ErrorCode.HOST_TIMEOUT, { command: 'ready' }), {
      code: ErrorCode.HOST_TIMEOUT,
      params: { command: 'ready' }
    });
  });

  it('recognizes error codes and AppErrorData', () => {
    assert.equal(isErrorCode(ErrorCode.VALIDATION_FAILED), true);
    assert.equal(isErrorCode('NOT_A_CODE'), false);
    assert.equal(isAppErrorData({ code: ErrorCode.INTERNAL }), true);
    assert.equal(isAppErrorData({ code: ErrorCode.INTERNAL, params: { detail: 'x' } }), true);
    assert.equal(isAppErrorData({ code: 'NOPE' }), false);
    assert.equal(isAppErrorData(null), false);
  });

  it('serializes AppError and normalizes unknowns', () => {
    const error = new AppError(ErrorCode.URL_INVALID, { detail: 'bad' });
    assert.deepEqual(error.toData(), { code: ErrorCode.URL_INVALID, params: { detail: 'bad' } });
    assert.deepEqual(toAppErrorData(error), error.toData());
    assert.deepEqual(toAppErrorData({ code: ErrorCode.CANCELLED }), { code: ErrorCode.CANCELLED });
    const normalized = toAppErrorData(new Error('secret-ish'));
    assert.equal(normalized.code, ErrorCode.INTERNAL);
    assert.equal(normalized.params?.['detail'], 'secret-ish');
  });
});

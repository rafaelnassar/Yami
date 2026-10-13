import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  abnormalExit,
  decideOutcome,
  launchFailureOutcome,
  statusForOutcome,
  type RunResult
} from './outcome-policy.ts';

function run(partial: Partial<RunResult> & Pick<RunResult, 'counters'>): RunResult {
  return { lastErrorKind: null, lastErrorLine: null, exitCode: null, exitSignal: null, ...partial };
}

describe('decideOutcome', () => {
  it('ok when something was produced without fatal errors and the exit was normal or unknown', () => {
    assert.deepEqual(decideOutcome(run({ counters: { done: 2, skipped: 1, errors: 0 }, exitCode: 0 })), {
      kind: 'ok',
      reason: null,
      detail: null
    });
    // skipped-only counts as produced; a re-attached run has no exit information
    assert.equal(decideOutcome(run({ counters: { done: 0, skipped: 3, errors: 0 } })).kind, 'ok');
  });

  it('partial when something was produced and fatal errors happened (legacy failed the whole job)', () => {
    const outcome = decideOutcome(
      run({
        counters: { done: 5, skipped: 0, errors: 1 },
        lastErrorKind: 'not-found',
        lastErrorLine: 'HTTP 404',
        exitCode: 1
      })
    );
    assert.deepEqual(outcome, { kind: 'partial', reason: 'not-found', detail: 'HTTP 404' });
    assert.equal(statusForOutcome(outcome.kind), 'completed');
  });

  it('error with the error kind when nothing was produced and a fatal error was seen', () => {
    assert.deepEqual(
      decideOutcome(
        run({ counters: { done: 0, skipped: 0, errors: 1 }, lastErrorKind: 'pixiv-auth', lastErrorLine: 'login' })
      ),
      { kind: 'error', reason: 'pixiv-auth', detail: 'login' }
    );
    assert.equal(decideOutcome(run({ counters: { done: 0, skipped: 0, errors: 2 } })).reason, 'unknown');
  });

  it('partial exit-code when something was produced but the engine did not exit normally (killed mid-run)', () => {
    const counters = { done: 50, skipped: 0, errors: 0 };
    // Windows: taskkill / Task Manager / antivirus end the process with a code.
    const killed = decideOutcome(run({ counters, exitCode: 1 }));
    assert.deepEqual(killed, { kind: 'partial', reason: 'exit-code', detail: 'exit 1' });
    assert.equal(statusForOutcome(killed.kind), 'completed');
    // POSIX: OOM killer / kill -9 (the code is then null).
    assert.deepEqual(decideOutcome(run({ counters, exitCode: null, exitSignal: 'SIGKILL' })), {
      kind: 'partial',
      reason: 'exit-code',
      detail: 'signal SIGKILL'
    });
    assert.deepEqual(decideOutcome(run({ counters, exitCode: 3221225477 })).detail, 'exit 3221225477');
  });

  it('a classified error line explains a partial run better than its exit code', () => {
    assert.deepEqual(
      decideOutcome(
        run({
          counters: { done: 1, skipped: 0, errors: 1 },
          lastErrorKind: 'rate-limited',
          lastErrorLine: '429',
          exitCode: 4
        })
      ),
      { kind: 'partial', reason: 'rate-limited', detail: '429' }
    );
  });

  it('error exit-code when nothing was produced and the exit code is non-zero or a signal ended it', () => {
    assert.deepEqual(decideOutcome(run({ counters: { done: 0, skipped: 0, errors: 0 }, exitCode: 2 })), {
      kind: 'error',
      reason: 'exit-code',
      detail: 'exit 2'
    });
    assert.deepEqual(decideOutcome(run({ counters: { done: 0, skipped: 0, errors: 0 }, exitSignal: 'SIGSEGV' })), {
      kind: 'error',
      reason: 'exit-code',
      detail: 'signal SIGSEGV'
    });
  });

  it('abnormalExit: only a known non-zero code or a signal', () => {
    assert.equal(abnormalExit({ exitCode: 0, exitSignal: null }), null);
    assert.equal(abnormalExit({ exitCode: null, exitSignal: null }), null, 'unknown (re-attached run)');
    assert.equal(abnormalExit({ exitCode: 101, exitSignal: null }), 'exit 101');
    assert.equal(abnormalExit({ exitCode: null, exitSignal: 'SIGTERM' }), 'signal SIGTERM');
  });

  it('empty when nothing was produced and there is no failure signal', () => {
    for (const exitCode of [0, null]) {
      assert.deepEqual(decideOutcome(run({ counters: { done: 0, skipped: 0, errors: 0 }, exitCode })), {
        kind: 'empty',
        reason: 'empty-result',
        detail: null
      });
    }
    // non-fatal errors do not make it an error, but the last line is kept as detail
    assert.deepEqual(decideOutcome(run({ counters: { done: 0, skipped: 0, errors: 0 }, lastErrorLine: 'retrying' })), {
      kind: 'empty',
      reason: 'empty-result',
      detail: 'retrying'
    });
    assert.equal(statusForOutcome('empty'), 'failed');
  });

  it('launch failures and cancellation', () => {
    assert.deepEqual(launchFailureOutcome('engine-missing'), { kind: 'error', reason: 'engine-missing', detail: null });
    assert.equal(statusForOutcome('cancelled'), 'cancelled');
  });
});

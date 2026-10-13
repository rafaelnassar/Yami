import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_DOWNLOAD_STATUSES,
  DOWNLOAD_STATUSES,
  EMPTY_DOWNLOAD_COUNTERS,
  TERMINAL_DOWNLOAD_STATUSES,
  isActiveStatus,
  isTerminalStatus
} from './download.ts';

describe('shared/domain/download', () => {
  it('lists every status exactly once across active and terminal', () => {
    const combined = new Set([...ACTIVE_DOWNLOAD_STATUSES, ...TERMINAL_DOWNLOAD_STATUSES]);
    assert.deepEqual([...combined].sort(), [...DOWNLOAD_STATUSES].sort());
    assert.equal(combined.size, DOWNLOAD_STATUSES.length);
  });

  it('classifies active and terminal statuses', () => {
    for (const status of ACTIVE_DOWNLOAD_STATUSES) {
      assert.equal(isActiveStatus(status), true);
      assert.equal(isTerminalStatus(status), false);
    }
    for (const status of TERMINAL_DOWNLOAD_STATUSES) {
      assert.equal(isActiveStatus(status), false);
      assert.equal(isTerminalStatus(status), true);
    }
  });

  it('starts counters at zero', () => {
    assert.deepEqual(EMPTY_DOWNLOAD_COUNTERS, { done: 0, skipped: 0, errors: 0 });
  });
});

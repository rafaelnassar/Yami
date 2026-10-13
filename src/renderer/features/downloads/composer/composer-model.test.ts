import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendToBatch, canSubmitBatch, checkBatch, linesFrom, pickGreeting } from './composer-model.ts';

describe('composer model', () => {
  it('parses unique, trimmed lines', () => {
    assert.deepEqual(linesFrom(' https://a.com \n\nhttps://b.com\r\nhttps://a.com'), [
      'https://a.com',
      'https://b.com'
    ]);
  });

  it('validates a batch', () => {
    assert.deepEqual(checkBatch('https://a.com\nftp://b.com\nnot a url'), {
      urls: ['https://a.com', 'ftp://b.com', 'not a url'],
      invalid: 2,
      overLimit: false
    });
    assert.equal(canSubmitBatch(checkBatch('https://a.com\nhttps://b.com')), true);
    assert.equal(canSubmitBatch(checkBatch('')), false);
    const huge = Array.from({ length: 501 }, (_, i) => `https://a.com/${i}`).join('\n');
    assert.equal(checkBatch(huge).overLimit, true);
    assert.equal(canSubmitBatch(checkBatch(huge)), false);
  });

  it('appends pasted URLs without duplicates', () => {
    assert.equal(appendToBatch('https://a.com', ['https://a.com', 'https://b.com']), 'https://a.com\nhttps://b.com');
    assert.equal(appendToBatch('', ['https://a.com']), 'https://a.com');
  });

  it('rotates greetings avoiding the current one', () => {
    assert.equal(
      pickGreeting(['a', 'b'], 'a', () => 0),
      'b'
    );
    assert.equal(
      pickGreeting(['only'], 'only', () => 0.9),
      'only'
    );
    assert.equal(pickGreeting([], null), '');
  });
});

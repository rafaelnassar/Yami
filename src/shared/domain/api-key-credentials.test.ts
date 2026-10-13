import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseApiKeyUserIdPaste } from './api-key-credentials.ts';

describe('parseApiKeyUserIdPaste', () => {
  it('parses the Gelbooru account-page query fragment', () => {
    assert.deepEqual(parseApiKeyUserIdPaste('&api_key=abcdef0123456789&user_id=2065192'), {
      apiKey: 'abcdef0123456789',
      userId: '2065192'
    });
  });

  it('accepts hyphenated keys and a leading question mark', () => {
    assert.deepEqual(parseApiKeyUserIdPaste('?api-key=abcdefghij&user-id=99'), {
      apiKey: 'abcdefghij',
      userId: '99'
    });
  });

  it('rejects missing fields or whitespace inside values', () => {
    assert.equal(parseApiKeyUserIdPaste('&api_key=abcdefghij'), null);
    assert.equal(parseApiKeyUserIdPaste('&user_id=1'), null);
    assert.equal(parseApiKeyUserIdPaste('&api_key=abcd efghij&user_id=1'), null);
    assert.equal(parseApiKeyUserIdPaste(''), null);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactSecrets } from './redaction.ts';

describe('redactSecrets', () => {
  it('redacts cookie and credential arguments', () => {
    assert.equal(redactSecrets('yt-dlp --cookies C:\\x\\c.txt --newline'), 'yt-dlp --cookies [redacted] --newline');
    assert.equal(redactSecrets('--cookies-from-browser chrome'), '--cookies-from-browser [redacted]');
    assert.equal(redactSecrets('--password "a b c"'), '--password [redacted]');
  });

  it('redacts tokens in key=value form, including gallery-dl options', () => {
    assert.equal(
      redactSecrets('-o extractor.pixiv.refresh-token=abc123'),
      '-o extractor.pixiv.refresh-token=[redacted]'
    );
    assert.equal(redactSecrets('access_token: xyz'), 'access_token=[redacted]');
  });

  it('strips query strings and credentials from URLs', () => {
    assert.equal(
      redactSecrets('GET https://u:p@cdn.x.com/a.jpg?sig=1&exp=2 ok'),
      'GET https://cdn.x.com/a.jpg?[redacted] ok'
    );
    assert.equal(redactSecrets('https://site.com/post/1'), 'https://site.com/post/1');
  });

  it('redacts bearer tokens', () => {
    assert.equal(redactSecrets('Authorization: Bearer abc.def-ghi'), 'Authorization: Bearer [redacted]');
  });

  it('hides sensitive directories with either separator', () => {
    const dir = 'C:\\Users\\ana\\AppData\\Roaming\\Yami\\data\\vault';
    assert.equal(
      redactSecrets(`reading C:/Users/ana/AppData/Roaming/Yami/data/vault/x.enc now`, { sensitiveDirs: [dir] }),
      'reading [private-path] now'
    );
  });
});

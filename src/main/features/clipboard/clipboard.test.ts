import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { ClipboardSuggestionDto } from '../../../shared/contracts/ipc.ts';
import { ok } from '../../../shared/kernel/result.ts';
import { FakeTimers } from '../../infrastructure/fake-timers.ts';
import { nullLogger } from '../../infrastructure/logger.ts';
import {
  buildHistoryIndex,
  extractHttpUrls,
  firstHttpUrl,
  normalizeForHistory,
  shouldSuggest
} from './clipboard-urls.ts';
import { ClipboardWatcher } from './clipboard-watcher.ts';
import { DismissedUrls, hashUrl } from './dismissed-urls.ts';

describe('clipboard URL extraction', () => {
  it('finds distinct http(s) URLs and strips trailing punctuation', () => {
    const text = 'see https://example.com/a), and http://x.org/b. also ftp://no.pe and https://example.com/a';
    assert.deepEqual(extractHttpUrls(text), ['https://example.com/a', 'http://x.org/b']);
    assert.equal(firstHttpUrl('nothing here'), null);
    assert.equal(firstHttpUrl('  https://a.b/c  '), 'https://a.b/c');
  });

  it('respects the maximum', () => {
    const text = Array.from({ length: 10 }, (_v, i) => `https://s${i}.com/`).join('\n');
    assert.equal(extractHttpUrls(text, 3).length, 3);
  });

  it('normalizes for history comparison', () => {
    assert.equal(normalizeForHistory('https://Example.com/a/b/#frag'), 'https://example.com/a/b');
    assert.equal(normalizeForHistory('https://example.com/'), 'https://example.com/');
    assert.equal(normalizeForHistory('javascript:alert(1)'), null);
  });

  it('suggests only new URLs of known sites', () => {
    const history = buildHistoryIndex(['https://www.site.com/post/1', 'https://other.org/x']);
    assert.deepEqual(shouldSuggest('https://site.com/post/2', history), {
      url: 'https://site.com/post/2',
      siteHost: 'site.com'
    });
    assert.equal(shouldSuggest('https://www.site.com/post/1/', history), null);
    assert.equal(shouldSuggest('https://unknown.net/p', history), null);
  });
});

describe('DismissedUrls', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yami-dismissed-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('persists only SHA-256 hashes, capped and newest last', () => {
    const file = path.join(dir, 'dismissed.json');
    const store = new DismissedUrls(file, nullLogger, 3);
    for (const n of [1, 2, 3, 4]) store.add(`https://s.com/${n}`);
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('s.com'));
    const reloaded = new DismissedUrls(file, nullLogger, 3);
    assert.equal(reloaded.has('https://s.com/1'), false);
    assert.equal(reloaded.has('https://s.com/4'), true);
    assert.equal(reloaded.has('https://s.com/4#x'), true);
    assert.match(hashUrl('https://s.com/4'), /^[a-f0-9]{64}$/);
  });
});

describe('ClipboardWatcher', () => {
  function setup(options: { ready?: boolean; dismissed?: string[] } = {}) {
    const timers = new FakeTimers();
    let clipboard = 'already here https://site.com/old';
    let historyCalls = 0;
    const suggestions: ClipboardSuggestionDto[] = [];
    const watcher = new ClipboardWatcher({
      readText: () => clipboard,
      fetchHistory: async () => {
        historyCalls += 1;
        return ok({ sourceUrls: ['https://site.com/p/1'] });
      },
      hostReady: () => options.ready ?? true,
      panelVisible: () => false,
      isDismissed: (url) => (options.dismissed ?? []).includes(url),
      suggest: (s) => suggestions.push(s),
      timers,
      now: () => timers.now,
      logger: nullLogger
    });
    return {
      watcher,
      suggestions,
      timers,
      copy: (text: string) => {
        clipboard = text;
      },
      historyCalls: () => historyCalls
    };
  }

  it('ignores the clipboard content present when enabled', async () => {
    const { watcher, suggestions } = setup();
    watcher.start();
    await watcher.tick();
    assert.deepEqual(suggestions, []);
  });

  it('suggests a new URL of a known site and caches the history for 60 s', async () => {
    const { watcher, suggestions, copy, historyCalls, timers } = setup();
    watcher.start();
    copy('https://site.com/p/2');
    await watcher.tick();
    assert.deepEqual(suggestions, [{ url: 'https://site.com/p/2', siteHost: 'site.com' }]);
    copy('https://site.com/p/3');
    await watcher.tick();
    assert.equal(historyCalls(), 1);
    timers.advance(60_000);
    copy('https://site.com/p/4');
    await watcher.tick();
    assert.equal(historyCalls(), 2);
  });

  it('skips downloaded, dismissed and unknown-site URLs, and a host that is not ready', async () => {
    const dismissed = setup({ dismissed: ['https://site.com/p/9'] });
    dismissed.watcher.start();
    for (const text of ['https://site.com/p/1', 'https://site.com/p/9', 'https://nope.com/x']) {
      dismissed.copy(text);
      await dismissed.watcher.tick();
    }
    assert.deepEqual(dismissed.suggestions, []);

    const offline = setup({ ready: false });
    offline.watcher.start();
    offline.copy('https://site.com/p/2');
    await offline.watcher.tick();
    assert.deepEqual(offline.suggestions, []);
    assert.equal(offline.historyCalls(), 0);
  });

  it('polls only while enabled', () => {
    const { watcher, timers } = setup();
    watcher.setEnabled(true);
    assert.equal(timers.pending, 1);
    watcher.setEnabled(false);
    assert.equal(timers.pending, 0);
  });
});

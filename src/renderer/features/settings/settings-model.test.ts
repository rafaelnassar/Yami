import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../../../shared/contracts/app-settings.ts';
import type { RuntimeStatusDto } from '../../../shared/contracts/dto.ts';
import {
  committableBindings,
  isValidRow,
  mergeHostBindings,
  normalizeSiteHost,
  sameBindings
} from './cookies/cookie-bindings-draft.ts';
import { cookieUploadProblem } from './cookies/cookie-upload.ts';
import { canMutateTool, emptyTool, orderedTools, pendingUpdates, runtimeCaption } from './runtime/runtime-tools.ts';
import { shouldShowSetup } from './runtime/setup-visibility.ts';
import { applySettingsPatch, createSettingsStore } from './settings-store.ts';

const runtime = (patch: Partial<RuntimeStatusDto> = {}): RuntimeStatusDto => ({
  mode: 'standalone',
  setupNeeded: false,
  setupDismissed: false,
  busy: false,
  operation: null,
  updatesCheckedAt: null,
  tools: [],
  integrityPinned: true,
  ...patch
});

describe('settings store', () => {
  it('merges nested ui patches', () => {
    const next = applySettingsPatch(DEFAULT_APP_SETTINGS, { adultBlur: false, ui: { trayEngine: 'yt-dlp' } });
    assert.equal(next.adultBlur, false);
    assert.equal(next.ui.trayEngine, 'yt-dlp');
    assert.equal(next.ui.sidebarWidth, DEFAULT_APP_SETTINGS.ui.sidebarWidth);
  });

  it('updates optimistically and rolls back when main rejects', async () => {
    let fail = false;
    const store = createSettingsStore({
      get: async () => ({ ok: true, data: DEFAULT_APP_SETTINGS }),
      update: async (patch) =>
        fail
          ? { ok: false, error: { code: 'VALIDATION_FAILED' } }
          : { ok: true, data: applySettingsPatch(DEFAULT_APP_SETTINGS, patch) }
    });
    assert.equal(await store.getState().update({ locale: 'en' }), null);
    assert.equal(store.getState().settings.locale, 'en');
    fail = true;
    const before: AppSettings = store.getState().settings;
    const pending = store.getState().update({ locale: 'es' });
    assert.equal(store.getState().settings.locale, 'es');
    assert.deepEqual(await pending, { code: 'VALIDATION_FAILED' });
    assert.equal(store.getState().settings, before);
  });
});

describe('cookie bindings draft', () => {
  const files = new Set(['a.txt', 'b.txt']);

  it('normalizes pasted URLs into hosts', () => {
    assert.equal(normalizeSiteHost(' https://www.Example.com:8080/path?q=1 '), 'example.com');
    assert.equal(normalizeSiteHost('.danbooru.donmai.us.'), 'danbooru.donmai.us');
  });

  it('commits only valid rows, first rule per host', () => {
    const rows = [
      { id: '1', siteHost: 'example.com', cookieName: 'a.txt' },
      { id: '2', siteHost: '', cookieName: 'a.txt' },
      { id: '3', siteHost: 'https://example.com', cookieName: 'b.txt' },
      { id: '4', siteHost: 'other.org', cookieName: 'missing.txt' },
      { id: '5', siteHost: 'bad host!', cookieName: 'a.txt' }
    ];
    assert.deepEqual(committableBindings(rows, files), [{ id: '1', siteHost: 'example.com', cookieName: 'a.txt' }]);
    assert.equal(isValidRow({ id: 'x', siteHost: 'x.com', cookieName: 'b.txt' }, files), true);
    assert.equal(
      sameBindings([{ id: '1', siteHost: 'a', cookieName: 'b' }], [{ id: '1', siteHost: 'a', cookieName: 'b' }]),
      true
    );
    assert.equal(sameBindings([], [{ id: '1', siteHost: 'a', cookieName: 'b' }]), false);
  });

  it('merges a host snapshot without deleting rows the user is still typing', () => {
    const local = [
      { id: '1', siteHost: 'https://www.Example.com', cookieName: 'a.txt' },
      { id: '2', siteHost: 'exam', cookieName: '' },
      { id: '3', siteHost: 'gone.org', cookieName: 'b.txt' },
      { id: '4', siteHost: 'bad host!', cookieName: 'a.txt' }
    ];
    const host = [
      { id: '1', siteHost: 'example.com', cookieName: 'a.txt' },
      { id: '9', siteHost: 'other.net', cookieName: 'b.txt' }
    ];
    assert.deepEqual(mergeHostBindings(local, host, files), [
      { id: '1', siteHost: 'example.com', cookieName: 'a.txt' },
      { id: '2', siteHost: 'exam', cookieName: '' },
      { id: '4', siteHost: 'bad host!', cookieName: 'a.txt' },
      { id: '9', siteHost: 'other.net', cookieName: 'b.txt' }
    ]);
  });

  it('keeps a committed rule the user turned invalid (it was dropped from the commit)', () => {
    const local = [{ id: '1', siteHost: '', cookieName: 'a.txt' }];
    assert.deepEqual(mergeHostBindings(local, [], files), local);
    assert.deepEqual(mergeHostBindings([], [{ id: '1', siteHost: 'x.com', cookieName: 'a.txt' }], files), [
      { id: '1', siteHost: 'x.com', cookieName: 'a.txt' }
    ]);
  });

  it('explains why a picked cookie file cannot be uploaded', () => {
    assert.equal(cookieUploadProblem({ name: 'cookies.txt', size: 10 }), null);
    assert.equal(cookieUploadProblem({ name: 'cookies.json', size: 10 }), 'extension');
    assert.equal(cookieUploadProblem({ name: 'coo#kies.txt', size: 10 }), 'name');
    assert.equal(cookieUploadProblem({ name: `${'a'.repeat(130)}.txt`, size: 10 }), 'name');
    assert.equal(cookieUploadProblem({ name: 'cookies.txt', size: 6 * 1024 * 1024 }), 'size');
    assert.equal(cookieUploadProblem({ name: 'cookies.txt', size: 0 }), 'empty');
  });
});

describe('runtime tools model', () => {
  it('orders tools and fills missing entries', () => {
    const tools = orderedTools([{ ...emptyTool('ffmpeg'), installed: true }]);
    assert.deepEqual(
      tools.map((tool) => tool.id),
      ['gallery-dl', 'yt-dlp', 'deno', 'ffmpeg', 'python']
    );
    assert.equal(tools[3]?.installed, true);
  });

  it('never mutates a system Python and lists pending updates', () => {
    assert.equal(canMutateTool({ ...emptyTool('python'), installed: true, source: 'system' }), false);
    assert.equal(canMutateTool({ ...emptyTool('python'), installed: true, source: 'managed' }), true);
    const pending = pendingUpdates([
      { ...emptyTool('yt-dlp'), installed: true, updateAvailable: true },
      { ...emptyTool('python'), installed: true, source: 'system', updateAvailable: true },
      { ...emptyTool('deno'), installed: false, updateAvailable: true }
    ]);
    assert.deepEqual(pending, ['yt-dlp']);
  });

  it('picks the caption', () => {
    assert.equal(runtimeCaption(runtime(), true, 0).key, 'ui.runtime.checkingUpdates');
    assert.deepEqual(runtimeCaption(runtime(), false, 2), { key: 'ui.runtime.pendingHint', count: 2 });
    assert.equal(runtimeCaption(runtime({ updatesCheckedAt: 5 }), false, 0).key, 'ui.runtime.upToDate');
    assert.equal(runtimeCaption(runtime(), false, 0).key, 'ui.runtime.ffmpegHint');
  });
});

describe('setup wizard visibility', () => {
  const base = { hostReady: true, settingsOpen: false, dismissedThisSession: false, open: false };

  it('shows for missing tools unless dismissed, and during installs', () => {
    assert.equal(shouldShowSetup({ ...base, runtime: runtime({ setupNeeded: true }) }), true);
    assert.equal(shouldShowSetup({ ...base, runtime: runtime({ setupNeeded: true, setupDismissed: true }) }), false);
    assert.equal(
      shouldShowSetup({ ...base, dismissedThisSession: true, runtime: runtime({ setupNeeded: true }) }),
      false
    );
    assert.equal(
      shouldShowSetup({
        ...base,
        runtime: runtime({ busy: true, operation: { id: 'o', kind: 'install', tools: [], startedAt: 1 } })
      }),
      true
    );
  });

  it('never pops up for update/check operations, while settings are open or offline', () => {
    assert.equal(
      shouldShowSetup({
        ...base,
        runtime: runtime({ busy: true, operation: { id: 'o', kind: 'update', tools: [], startedAt: 1 } })
      }),
      false
    );
    assert.equal(shouldShowSetup({ ...base, settingsOpen: true, runtime: runtime({ setupNeeded: true }) }), false);
    assert.equal(shouldShowSetup({ ...base, hostReady: false, runtime: runtime({ setupNeeded: true }) }), false);
    assert.equal(shouldShowSetup({ ...base, open: true, runtime: runtime() }), true);
  });
});

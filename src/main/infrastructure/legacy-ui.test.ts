import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../../shared/contracts/app-settings.ts';
import { err, ok, type Result } from '../../shared/kernel/result.ts';
import type { AppErrorData } from '../../shared/kernel/errors.ts';
import { nullLogger } from './logger.ts';
import { LegacyUiImporter } from './legacy-ui-import.ts';
import { applyLegacyPreferences, parseLegacyUiPayload, type LegacyHostData } from './legacy-ui-payload.ts';

const LEGACY = JSON.stringify({
  recentFiles: [{ path: '/x', name: 'x', ts: 1 }],
  quickEngine: 'yt-dlp',
  bulkEngine: 'gallery-dl',
  sidebarOpen: false,
  locale: 'en',
  blurAdultContent: false,
  conversationFolders: [
    { id: 'f1', name: ' Art ', color: '#ff0000', createdAt: 1700000000000.5, collapsed: 1 },
    { id: 'bad id!', name: 'x', color: '#000', createdAt: 1 },
    { id: 'f2', name: '', color: '#000', createdAt: 1 },
    { id: 'f3', name: 'Videos', color: '#00ff00', createdAt: 2, collapsed: true },
    { id: 'f1', name: 'dup', color: '#000', createdAt: 3 }
  ],
  conversationFolderMap: { c1: 'f1', c2: 'f3', c3: 'missing', 'bad key': 'f1', c4: 7 },
  cookieBindings: [
    { id: 'b1', siteHost: 'pixiv.net', cookieFileName: 'pixiv.txt', obsolete: true },
    { id: 'b2', siteHost: '', cookieFileName: 'x.txt' }
  ]
});

describe('parseLegacyUiPayload', () => {
  it('salvages every valid entry and maps legacy field names', () => {
    const data = parseLegacyUiPayload(LEGACY);
    assert.ok(data);
    assert.equal(data.locale, 'en');
    assert.equal(data.adultBlur, false);
    assert.equal(data.quickEngine, 'yt-dlp');
    assert.equal(data.bulkEngine, 'gallery-dl');
    assert.deepEqual(data.host.folders, [
      { id: 'f1', name: 'Art', color: '#ff0000', createdAt: 1700000000000, collapsed: true },
      { id: 'f3', name: 'Videos', color: '#00ff00', createdAt: 2, collapsed: true }
    ]);
    assert.deepEqual(data.host.folderMap, { c1: 'f1', c2: 'f3' });
    assert.deepEqual(data.host.cookieBindings, [{ id: 'b1', siteHost: 'pixiv.net', cookieName: 'pixiv.txt' }]);
  });

  it('returns null for missing or broken payloads and tolerates wrong types', () => {
    assert.equal(parseLegacyUiPayload(null), null);
    assert.equal(parseLegacyUiPayload('{oops'), null);
    assert.equal(parseLegacyUiPayload('[1]'), null);
    const odd = parseLegacyUiPayload(JSON.stringify({ locale: 'fr', quickEngine: 'wget', conversationFolders: 'x' }));
    assert.ok(odd);
    assert.equal(odd.locale, null);
    assert.equal(odd.quickEngine, null);
    assert.deepEqual(odd.host, { folders: [], folderMap: {}, cookieBindings: [] });
  });

  it('maps preferences onto settings', () => {
    const data = parseLegacyUiPayload(LEGACY);
    assert.ok(data);
    const next = applyLegacyPreferences(DEFAULT_APP_SETTINGS, data, 99);
    assert.equal(next.locale, 'en');
    assert.equal(next.adultBlur, false);
    assert.deepEqual(next.ui.composerEngine, { single: 'yt-dlp', bulk: 'gallery-dl' });
    assert.equal(next.ui.trayEngine, 'yt-dlp');
    assert.equal(next.legacyImportedAt, 99);
  });
});

describe('LegacyUiImporter', () => {
  function setup(
    raw: string | null | Error,
    hostResult: Result<{ folders: number; assignments: number; bindings: number }, AppErrorData>,
    vault = { ready: true }
  ) {
    let settings: AppSettings = DEFAULT_APP_SETTINGS;
    const sent: LegacyHostData[] = [];
    const importer = new LegacyUiImporter({
      settings: {
        get: () => settings,
        updateInternal: (change) => {
          settings = change(settings);
          return ok(settings);
        }
      },
      readLegacyStorage: async () => {
        if (raw instanceof Error) throw raw;
        return raw;
      },
      importToHost: async (data) => {
        sent.push(data);
        return hostResult;
      },
      now: () => 1234,
      vaultReady: () => vault.ready,
      logger: nullLogger
    });
    return { importer, sent, settings: () => settings };
  }

  it('waits for a working vault before importing (bindings need it)', async () => {
    const vault = { ready: false };
    const { importer, sent, settings } = setup(LEGACY, ok({ folders: 2, assignments: 2, bindings: 1 }), vault);
    assert.equal(importer.needed, false);
    await importer.run();
    assert.equal(sent.length, 0);
    assert.equal(settings().legacyImportedAt, null);
    vault.ready = true;
    assert.equal(importer.needed, true);
    await importer.run();
    assert.equal(sent.length, 1);
    assert.equal(settings().legacyImportedAt, 1234);
  });

  it('imports once: host data + preferences, then marks done', async () => {
    const { importer, sent, settings } = setup(LEGACY, ok({ folders: 2, assignments: 2, bindings: 1 }));
    assert.equal(importer.needed, true);
    await importer.run();
    assert.equal(sent.length, 1);
    assert.equal(settings().locale, 'en');
    assert.equal(settings().legacyImportedAt, 1234);
    assert.equal(importer.needed, false);
    await importer.run();
    assert.equal(sent.length, 1);
  });

  it('marks done even when reading or the host import fails', async () => {
    const failing = setup(new Error('boom'), ok({ folders: 0, assignments: 0, bindings: 0 }));
    await failing.importer.run();
    assert.equal(failing.settings().legacyImportedAt, 1234);

    const rejected = setup(LEGACY, err({ code: 'HOST_UNAVAILABLE' }));
    await rejected.importer.run();
    assert.equal(rejected.settings().legacyImportedAt, 1234);
    assert.equal(rejected.settings().locale, 'en');
  });

  it('skips the host call when there is nothing to import', async () => {
    const { importer, sent, settings } = setup(null, ok({ folders: 0, assignments: 0, bindings: 0 }));
    await importer.run();
    assert.equal(sent.length, 0);
    assert.equal(settings().legacyImportedAt, 1234);
  });
});

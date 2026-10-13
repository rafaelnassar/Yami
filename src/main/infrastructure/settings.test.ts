import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_APP_SETTINGS } from '../../shared/contracts/app-settings.ts';
import { nullLogger } from './logger.ts';
import { applySettingsPatch, normalizeSettings } from './settings-merge.ts';
import { SettingsStore } from './settings-store.ts';

describe('normalizeSettings', () => {
  it('returns defaults for garbage', () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_APP_SETTINGS);
    assert.deepEqual(normalizeSettings('nope'), DEFAULT_APP_SETTINGS);
    assert.deepEqual(normalizeSettings([1, 2]), DEFAULT_APP_SETTINGS);
  });

  it('keeps valid fields, resets invalid ones individually and drops unknown keys', () => {
    const settings = normalizeSettings({
      version: 99,
      locale: 'en',
      adultBlur: 'yes',
      clipboardWatch: true,
      removedFeature: 42,
      ui: {
        sidebarWidth: 9999,
        composerEngine: { single: 'yt-dlp', bulk: 'nope' },
        legacyThing: 1
      },
      legacyImportedAt: 123
    });
    assert.equal(settings.version, 1);
    assert.equal(settings.locale, 'en');
    assert.equal(settings.adultBlur, DEFAULT_APP_SETTINGS.adultBlur);
    assert.equal(settings.clipboardWatch, true);
    assert.equal(settings.ui.sidebarWidth, DEFAULT_APP_SETTINGS.ui.sidebarWidth);
    assert.deepEqual(settings.ui.composerEngine, DEFAULT_APP_SETTINGS.ui.composerEngine);
    assert.equal(settings.legacyImportedAt, 123);
    assert.ok(!('removedFeature' in settings));
    assert.ok(!('legacyThing' in settings.ui));
  });

  it('applies patches one level deep into ui', () => {
    const next = applySettingsPatch(DEFAULT_APP_SETTINGS, { locale: 'es', ui: { trayEngine: 'yt-dlp' } });
    assert.equal(next.locale, 'es');
    assert.equal(next.ui.trayEngine, 'yt-dlp');
    assert.equal(next.ui.sidebarWidth, DEFAULT_APP_SETTINGS.ui.sidebarWidth);
  });
});

describe('SettingsStore', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yami-settings-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('migrates the file on load and persists validated patches atomically', () => {
    const file = path.join(dir, 'a', 'settings.json');
    const store = new SettingsStore(file, nullLogger);
    assert.deepEqual(store.get(), DEFAULT_APP_SETTINGS);
    const seen: string[] = [];
    store.onChange((next, previous) => seen.push(`${previous.locale}->${next.locale}`));

    const updated = store.update({ locale: 'en', ui: { sidebarWidth: 300 } });
    assert.equal(updated.ok, true);
    assert.deepEqual(seen, ['pt->en']);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { locale: string; ui: { sidebarWidth: number } };
    assert.equal(onDisk.locale, 'en');
    assert.equal(onDisk.ui.sidebarWidth, 300);
    assert.deepEqual(readdirSync(path.dirname(file)), ['settings.json']);

    const reloaded = new SettingsStore(file, nullLogger);
    assert.equal(reloaded.get().locale, 'en');
  });

  it('rejects invalid or privileged patches from the renderer', () => {
    const store = new SettingsStore(path.join(dir, 'b.json'), nullLogger);
    for (const patch of [
      { locale: 'fr' },
      { legacyImportedAt: 1 },
      { version: 2 },
      { ui: { sidebarWidth: 10 } },
      null
    ]) {
      const result = store.update(patch);
      assert.equal(result.ok, false, JSON.stringify(patch));
      if (!result.ok) assert.equal(result.error.code, 'VALIDATION_FAILED');
    }
    assert.equal(store.updateInternal((s) => ({ ...s, legacyImportedAt: 5 })).ok, true);
    assert.equal(store.get().legacyImportedAt, 5);
  });

  it('moves a corrupted file aside and starts from defaults', () => {
    const file = path.join(dir, 'c.json');
    writeFileSync(file, '{ not json');
    const store = new SettingsStore(file, nullLogger);
    assert.deepEqual(store.get(), DEFAULT_APP_SETTINGS);
    assert.ok(readdirSync(dir).some((name) => name.startsWith('c.json.corrupt-')));
    assert.equal(existsSync(file), false);
  });

  it('rewrites a file with unknown keys in canonical form', () => {
    const file = path.join(dir, 'd.json');
    writeFileSync(file, JSON.stringify({ locale: 'es', obsolete: true }));
    new SettingsStore(file, nullLogger);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk['locale'], 'es');
    assert.ok(!('obsolete' in onDisk));
    assert.equal(onDisk['version'], 1);
  });
});

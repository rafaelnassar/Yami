import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ErrorCode } from '../kernel/errors.ts';
import { CATALOG, translatorFor } from './catalog.ts';

describe('i18n catalog', () => {
  it('has a message for every error code in every locale', () => {
    for (const locale of ['pt', 'en', 'es'] as const) {
      for (const code of Object.values(ErrorCode)) {
        assert.ok(CATALOG[locale][`errors.${code}`], `missing errors.${code} for ${locale}`);
      }
    }
  });

  it('has the same keys and placeholders in every locale', () => {
    const placeholders = (text: string): string =>
      [...text.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(',');
    for (const key of Object.keys(CATALOG.pt)) {
      for (const locale of ['en', 'es'] as const) {
        const other = CATALOG[locale][key];
        assert.ok(other !== undefined, `missing ${key} for ${locale}`);
        assert.equal(
          placeholders(other),
          placeholders(CATALOG.pt[key] ?? ''),
          `placeholder mismatch in ${key} (${locale})`
        );
      }
    }
  });

  it('interpolates params and falls back to the key', () => {
    const t = translatorFor('en');
    assert.equal(t.t('errors.URL_LIMIT_EXCEEDED', { max: 500 }), 'Limit of 500 links per batch.');
    assert.equal(t.tDynamic('errors.NOPE', {}, 'fallback'), 'fallback');
  });
});

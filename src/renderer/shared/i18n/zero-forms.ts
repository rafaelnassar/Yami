/**
 * Zero forms for counted messages. The shared translator only knows `_one` /
 * `_other`, and Portuguese plural rules put 0 in the `one` category ("0 arquivo
 * salvo"). The UI wraps the translator: with `count === 0`, a `<key>_zero`
 * message wins when one exists ("Nenhum arquivo salvo"); otherwise nothing changes.
 */
import type { TranslateParams } from '../../../shared/i18n/translator.ts';
import type { UiTranslator } from './text.ts';

export function withZeroForms(base: UiTranslator): UiTranslator {
  const zeroKey = (key: string, params: TranslateParams | undefined): string | null => {
    if (params?.['count'] !== 0) return null;
    const candidate = `${key}_zero`;
    return base.has(candidate) ? candidate : null;
  };
  return {
    locale: base.locale,
    t: (key, params) => {
      const zero = zeroKey(key, params);
      return zero ? base.tDynamic(zero, params) : base.t(key, params);
    },
    tDynamic: (key, params, fallback) => base.tDynamic(zeroKey(key, params) ?? key, params, fallback),
    has: (key) => base.has(key)
  };
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { translatorFor, type MessageKey } from '../../../shared/i18n/catalog.ts';
import { createTranslator } from '../../../shared/i18n/translator.ts';
import { withZeroForms } from './zero-forms.ts';

describe('zero forms', () => {
  it('uses the `_zero` message for count 0 and the plural rules otherwise', () => {
    const base = {
      'ui.x_zero': 'No files',
      'ui.x_one': '{count} file',
      'ui.x_other': '{count} files',
      'ui.y_one': '{count} y',
      'ui.y_other': '{count} ys'
    };
    const t = withZeroForms(createTranslator<MessageKey>('pt', { pt: base, en: base, es: base }));
    assert.equal(t.tDynamic('ui.x', { count: 0 }), 'No files');
    assert.equal(t.tDynamic('ui.x', { count: 1 }), '1 file');
    assert.equal(t.tDynamic('ui.x', { count: 2 }), '2 files');
    assert.equal(t.tDynamic('ui.y', { count: 0 }), '0 y', 'without a zero form, Portuguese treats 0 as singular');
    assert.equal(t.locale, 'pt');
  });

  it('fixes the Portuguese "0 arquivo salvo" / "0 link no lote" messages of the real catalog', () => {
    const t = withZeroForms(translatorFor('pt'));
    assert.equal(t.t('ui.session.toast.completedMsg', { count: 0 }), 'Nenhum arquivo novo salvo.');
    assert.equal(t.t('ui.session.toast.completedMsg', { count: 1 }), '1 arquivo salvo.');
    assert.match(t.t('ui.composer.help.batch', { count: 0 }), /^Nenhum link/);
    assert.equal(t.t('ui.result.count.file', { count: 0 }), 'Nenhum arquivo');
    assert.equal(withZeroForms(translatorFor('en')).t('ui.result.count.image', { count: 3 }), '3 images');
  });
});

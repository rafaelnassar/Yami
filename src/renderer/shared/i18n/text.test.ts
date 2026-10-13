import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTranslator } from '../../../shared/i18n/translator.ts';
import { translatorFor, type MessageKey } from '../../../shared/i18n/catalog.ts';
import {
  cleanText,
  formatConversationEvent,
  formatError,
  formatLogEntry,
  formatNotice,
  formatOutcome,
  formatRuntimeProgress,
  type UiTranslator
} from './text.ts';

/** Translator over a tiny catalog, so the tests do not depend on other layers' message files. */
function fakeTranslator(entries: Record<string, string>): UiTranslator {
  const base: Record<string, string> = {
    'ui.errors.unknown': 'Unknown error.',
    'ui.notices.kind.error': 'Error',
    'ui.notices.kind.warn': 'Warning',
    'ui.notices.kind.success': 'Success',
    'ui.notices.kind.info': 'Info',
    'ui.outcome.unknown': 'Finished.',
    'ui.outcome.error': 'Failed.',
    'ui.runtime.progress.working': 'Working…',
    ...entries
  };
  return createTranslator<MessageKey>('en', { pt: base, en: base, es: base });
}

describe('structured text formatting', () => {
  it('translates error codes with params and drops unfilled placeholders', () => {
    const t = fakeTranslator({
      'errors.INTERNAL': 'Something went wrong. {detail}',
      'errors.URL_INVALID': 'Invalid link: {url}'
    });
    assert.equal(formatError(t, { code: 'INTERNAL' }), 'Something went wrong.');
    assert.equal(formatError(t, { code: 'URL_INVALID', params: { url: 'x' } }), 'Invalid link: x');
    assert.equal(formatError(t, { code: 'HOST_TIMEOUT' }), 'Unknown error.');
    assert.equal(formatError(t, null), 'Unknown error.');
  });

  it('uses the real catalog for every error code', () => {
    const t = translatorFor('pt');
    assert.equal(formatError(t, { code: 'URL_LIMIT_EXCEEDED', params: { max: 500 } }), 'Limite de 500 links por lote.');
  });

  it('falls back to the notice kind when a notice code is unknown', () => {
    const t = fakeTranslator({
      'notices.batch-done.title': 'Batch done',
      'notices.batch-done.message': '{count} links'
    });
    assert.deepEqual(formatNotice(t, { code: 'batch-done', kind: 'success', params: { count: 3 } }), {
      title: 'Batch done',
      message: '3 links'
    });
    assert.deepEqual(formatNotice(t, { code: 'nope', kind: 'warn', params: {} }), { title: 'Warning', message: '' });
  });

  it('formats conversation events, preferring translations over legacy text', () => {
    const t = fakeTranslator({
      'conversationEvents.started': 'Started with {engine}.',
      'outcomes.reason.pixiv-auth': 'Pixiv needs a login.'
    });
    assert.equal(
      formatConversationEvent(t, {
        code: 'started',
        type: 'started',
        params: { engine: 'yt-dlp' },
        legacyMessage: null
      }),
      'Started with yt-dlp.'
    );
    assert.equal(
      formatConversationEvent(t, { code: 'x', type: 'legacy', params: {}, legacyMessage: 'Old text' }),
      'Old text'
    );
    assert.equal(
      formatConversationEvent(t, { code: 'raw-code', type: 'failed', params: {}, legacyMessage: null }),
      'raw-code'
    );
    assert.equal(
      formatConversationEvent(t, {
        code: 'failed',
        type: 'failed',
        params: { reason: 'pixiv-auth', detail: '' },
        legacyMessage: null
      }),
      'Pixiv needs a login.'
    );
  });

  it('resolves outcomes from the most specific key available', () => {
    const t = fakeTranslator({ 'outcomes.reason.engine-missing': '{detail} missing' });
    assert.equal(formatOutcome(t, { kind: 'error', reason: 'engine-missing', detail: 'yt-dlp' }), 'yt-dlp missing');
    assert.equal(formatOutcome(t, { kind: 'error', reason: 'other', detail: null }), 'Failed.');
    assert.equal(formatOutcome(t, { kind: 'ok', reason: null, detail: null }), 'Finished.');
  });

  it('formats runtime progress and log entries', () => {
    const t = fakeTranslator({
      'runtimeProgress.download': 'Downloading {tool}',
      'logs.engine-start': 'Starting {engine}'
    });
    assert.equal(formatRuntimeProgress(t, { code: 'download', params: { tool: 'ffmpeg' } }), 'Downloading ffmpeg');
    assert.equal(formatRuntimeProgress(t, { code: 'unknown', params: {} }), 'Working…');
    assert.equal(formatLogEntry(t, { text: '[download] 5%', code: null, params: {} }), '[download] 5%');
    assert.equal(
      formatLogEntry(t, { text: null, code: 'engine-start', params: { engine: 'gallery-dl' } }),
      'Starting gallery-dl'
    );
    assert.equal(formatLogEntry(t, { text: null, code: 'mystery', params: {} }), 'mystery');
  });

  it('cleans leftover placeholders and spacing', () => {
    assert.equal(cleanText('Failed ({detail}) now {x}.'), 'Failed now.');
  });
});

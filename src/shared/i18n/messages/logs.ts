/**
 * `logs.<code>` — host-generated log lines (owned by the host downloads core).
 * Engine output and the command line travel as raw redacted `text` instead.
 * `{url}` is already stripped of query strings/credentials.
 */
import { defineMessages } from '../define.ts';

export const logsMessages = defineMessages(
  {
    queued: 'Enfileirado: {count} URL(s) com {engine}.',
    reattached: 'Reconectado ao download em andamento: {url}',
    finished: 'Concluído: {url}',
    finishedWithErrors: 'Concluído com erros: {url}',
    failed: 'Falhou: {url}',
    cancelled: 'Cancelado: {url}',
    retryWithoutBrowserCookies: 'Nova tentativa sem cookies do navegador: {url}',
    retryWithBrowserCookies: 'Nova tentativa com cookies do navegador: {url}',
    pausedAll: 'Downloads pausados: {count}.',
    resumedAll: 'Downloads retomados: {count}.',
    stoppedAll: 'Downloads interrompidos: {count}.'
  },
  {
    en: {
      queued: 'Queued: {count} URL(s) with {engine}.',
      reattached: 'Reconnected to a running download: {url}',
      finished: 'Finished: {url}',
      finishedWithErrors: 'Finished with errors: {url}',
      failed: 'Failed: {url}',
      cancelled: 'Cancelled: {url}',
      retryWithoutBrowserCookies: 'Retrying without browser cookies: {url}',
      retryWithBrowserCookies: 'Retrying with browser cookies: {url}',
      pausedAll: 'Downloads paused: {count}.',
      resumedAll: 'Downloads resumed: {count}.',
      stoppedAll: 'Downloads stopped: {count}.'
    },
    es: {
      queued: 'En cola: {count} URL(s) con {engine}.',
      reattached: 'Reconectado a una descarga en curso: {url}',
      finished: 'Completada: {url}',
      finishedWithErrors: 'Completada con errores: {url}',
      failed: 'Falló: {url}',
      cancelled: 'Cancelada: {url}',
      retryWithoutBrowserCookies: 'Reintentando sin cookies del navegador: {url}',
      retryWithBrowserCookies: 'Reintentando con cookies del navegador: {url}',
      pausedAll: 'Descargas en pausa: {count}.',
      resumedAll: 'Descargas reanudadas: {count}.',
      stoppedAll: 'Descargas detenidas: {count}.'
    }
  }
);

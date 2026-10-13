/**
 * `notices.<code>.title|message` emitted by the downloads core (owned by host/application/downloads).
 *
 * `downloadFailed` params: `{engine, title, reason, detail}` — `reason` is the
 * outcome reason (render `outcomes.reason.<reason>` for a friendly explanation,
 * especially when `detail` is empty); `detail` is the last engine error line
 * (redacted) or `''`.
 *
 * `downloadWaitingVault` params: `{engine, title, cookie}` — the download was paused
 * because its chosen cookie file (`cookie`) is in a disabled vault.
 */
import { defineMessages } from '../define.ts';

export const noticesDownloadsMessages = defineMessages(
  {
    'downloadFailed.title': 'Falha no download ({engine})',
    'downloadFailed.message': '“{title}” não foi concluído. {detail}',
    'downloadWaitingVault.title': 'Download pausado: cofre indisponível',
    'downloadWaitingVault.message':
      '“{title}” usa o cookie “{cookie}”, que está no cofre indisponível. Ele fica pausado com os arquivos parciais; retome depois de resolver o cofre em Ajustes › Cookies por site.'
  },
  {
    en: {
      'downloadFailed.title': 'Download failed ({engine})',
      'downloadFailed.message': '“{title}” did not finish. {detail}',
      'downloadWaitingVault.title': 'Download paused: vault unavailable',
      'downloadWaitingVault.message':
        '“{title}” uses the cookie “{cookie}”, which is in the unavailable vault. It stays paused with its partial files; resume it after fixing the vault in Settings › Cookies by site.'
    },
    es: {
      'downloadFailed.title': 'Falló la descarga ({engine})',
      'downloadFailed.message': '“{title}” no se completó. {detail}',
      'downloadWaitingVault.title': 'Descarga en pausa: almacén no disponible',
      'downloadWaitingVault.message':
        '“{title}” usa la cookie “{cookie}”, que está en el almacén no disponible. Queda en pausa con sus archivos parciales; reanúdala tras resolver el almacén en Ajustes › Cookies por sitio.'
    }
  }
);

/**
 * `conversationEvents.<code>` — timeline entries of a download (owned by the host
 * downloads core, `host/application/downloads/conversation-events.ts`).
 *
 * `code` comes from `ConversationEventDto.code`; params never contain `null`
 * (missing details are sent as `''`). `{detail}` is raw, redacted engine text.
 */
import { defineMessages } from '../define.ts';

export const conversationEventsMessages = defineMessages(
  {
    created: 'Download adicionado à conversa.',
    started: 'Download iniciado com {engine}.',
    paused: 'Processo interrompido (pausa).',
    pausedBeforeStart: 'Download pausado antes de iniciar.',
    pausedOnExit: 'Interrompido ao fechar o app; continua automaticamente na próxima abertura.',
    pausedUnsupervised:
      'Não foi possível retomar o acompanhamento deste download após reiniciar; ele foi pausado. Retome quando quiser.',
    pausedVaultUnavailable:
      'Pausado: o arquivo de cookies escolhido está no cofre indisponível. Os arquivos parciais foram mantidos; retome depois de desbloquear ou redefinir o cofre.',
    resumed: 'Recolocado na fila; os engines ignoram o que já foi baixado e continuam arquivos .part.',
    interrupted: 'Download interrompido.',
    cancelled: 'Download cancelado.',
    restarted: 'Download reiniciado.',
    retryWithoutBrowserCookies: 'Cookies do navegador indisponíveis; tentando de novo sem cookies.',
    retryWithBrowserCookies: 'O site pediu login; tentando de novo com a sessão do navegador.',
    completed: 'Download concluído: {done} baixado(s), {skipped} ignorado(s).',
    completedWithErrors: 'Concluído com erros: {done} baixado(s), {skipped} ignorado(s), {errors} erro(s).',
    completedInterrupted:
      'O engine parou antes do fim ({detail}): {done} baixado(s), {skipped} ignorado(s). Reinicie o download para buscar o resto.',
    failedEmpty: 'Nenhum arquivo baixado nem ignorado. {detail}',
    failedEngineMissing: '{engine} não está disponível.',
    failedToStart: 'Falha ao iniciar o processo. {detail}',
    failedCookies: 'Não foi possível preparar o arquivo de cookies ({detail}).',
    failedVault: 'O cofre de cookies está indisponível; o arquivo escolhido ({detail}) não pôde ser usado.',
    failedExitCode: 'O engine terminou com erro ({detail}).',
    failed: 'O download falhou. {detail}'
  },
  {
    en: {
      created: 'Download added to the conversation.',
      started: 'Download started with {engine}.',
      paused: 'Process stopped (pause).',
      pausedBeforeStart: 'Download paused before starting.',
      pausedOnExit: 'Interrupted when the app closed; it continues automatically next time the app opens.',
      pausedUnsupervised:
        'This download could not be tracked again after a restart, so it was paused. Resume it whenever you like.',
      pausedVaultUnavailable:
        'Paused: the chosen cookie file is in the unavailable vault. Partial files were kept; resume it after unlocking or resetting the vault.',
      resumed: 'Queued again; the engines skip what is already downloaded and continue .part files.',
      interrupted: 'Download interrupted.',
      cancelled: 'Download cancelled.',
      restarted: 'Download restarted.',
      retryWithoutBrowserCookies: 'Browser cookies unavailable; trying again without cookies.',
      retryWithBrowserCookies: 'The site asked for a login; trying again with the browser session.',
      completed: 'Download finished: {done} downloaded, {skipped} skipped.',
      completedWithErrors: 'Finished with errors: {done} downloaded, {skipped} skipped, {errors} error(s).',
      completedInterrupted:
        'The engine stopped before finishing ({detail}): {done} downloaded, {skipped} skipped. Restart the download to fetch the rest.',
      failedEmpty: 'Nothing was downloaded or skipped. {detail}',
      failedEngineMissing: '{engine} is not available.',
      failedToStart: 'Could not start the process. {detail}',
      failedCookies: 'Could not prepare the cookies file ({detail}).',
      failedVault: 'The cookie vault is unavailable; the chosen file ({detail}) could not be used.',
      failedExitCode: 'The engine exited with an error ({detail}).',
      failed: 'The download failed. {detail}'
    },
    es: {
      created: 'Descarga añadida a la conversación.',
      started: 'Descarga iniciada con {engine}.',
      paused: 'Proceso detenido (pausa).',
      pausedBeforeStart: 'Descarga en pausa antes de empezar.',
      pausedOnExit: 'Interrumpida al cerrar la app; continúa automáticamente la próxima vez que se abra.',
      pausedUnsupervised:
        'No se pudo volver a seguir esta descarga tras reiniciar, así que se pausó. Reanúdala cuando quieras.',
      pausedVaultUnavailable:
        'En pausa: el archivo de cookies elegido está en el almacén no disponible. Se conservaron los archivos parciales; reanúdala tras desbloquear o restablecer el almacén.',
      resumed: 'De vuelta en la cola; los engines omiten lo ya descargado y continúan los archivos .part.',
      interrupted: 'Descarga interrumpida.',
      cancelled: 'Descarga cancelada.',
      restarted: 'Descarga reiniciada.',
      retryWithoutBrowserCookies: 'Cookies del navegador no disponibles; reintentando sin cookies.',
      retryWithBrowserCookies: 'El sitio pidió iniciar sesión; reintentando con la sesión del navegador.',
      completed: 'Descarga completada: {done} descargado(s), {skipped} omitido(s).',
      completedWithErrors: 'Completada con errores: {done} descargado(s), {skipped} omitido(s), {errors} error(es).',
      completedInterrupted:
        'El engine se detuvo antes de terminar ({detail}): {done} descargado(s), {skipped} omitido(s). Reinicia la descarga para obtener el resto.',
      failedEmpty: 'No se descargó ni se omitió ningún archivo. {detail}',
      failedEngineMissing: '{engine} no está disponible.',
      failedToStart: 'No se pudo iniciar el proceso. {detail}',
      failedCookies: 'No se pudo preparar el archivo de cookies ({detail}).',
      failedVault: 'El almacén de cookies no está disponible; no se pudo usar el archivo elegido ({detail}).',
      failedExitCode: 'El engine terminó con un error ({detail}).',
      failed: 'La descarga falló. {detail}'
    }
  }
);

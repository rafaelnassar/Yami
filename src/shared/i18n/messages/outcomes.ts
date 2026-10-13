/**
 * Download outcome texts (owned by the host downloads core).
 *
 * Key scheme — build keys directly from `DownloadOutcomeDto`, no mapping needed:
 * - `outcomes.<kind>` — short label: `ok`, `partial`, `empty`, `error`, `cancelled`;
 * - `outcomes.reason.<reason>` — explanation, where `<reason>` is `DownloadOutcomeDto.reason`
 *   verbatim (kebab-case, e.g. `outcomes.reason.engine-missing`, `outcomes.reason.pixiv-auth`).
 *   Reasons are the launch failures, `exit-code`, `empty-result`, `unknown` and every
 *   `EngineErrorKind`. Use `tDynamic` with a fallback for reasons added later.
 */
import { defineMessages } from '../define.ts';

export const outcomesMessages = defineMessages(
  {
    ok: 'Concluído',
    partial: 'Concluído com erros',
    empty: 'Nada baixado',
    error: 'Falhou',
    cancelled: 'Cancelado',
    'reason.engine-missing': 'O engine não está instalado. Instale as ferramentas em Ajustes.',
    'reason.spawn-failed': 'Não foi possível iniciar o processo do engine.',
    'reason.workspace-failed': 'Não foi possível preparar a pasta temporária do download.',
    'reason.cookies-unavailable':
      'O arquivo de cookies escolhido não está disponível. Envie-o de novo nas configurações.',
    'reason.vault-unavailable':
      'O cofre de cookies está indisponível, então o arquivo escolhido não pôde ser usado. Baixe sem escolher cookies ou redefina o cofre em Ajustes › Cookies por site.',
    'reason.exit-code': 'O engine terminou com erro ou foi encerrado antes do fim ({detail}). Veja os logs.',
    'reason.empty-result': 'Nenhum arquivo baixado nem ignorado.',
    'reason.unknown': 'Erro não identificado. Veja os logs.',
    'reason.cookie-copy':
      'Não foi possível copiar os cookies do navegador. Feche o navegador e tente de novo, ou desative “Usar cookies do navegador” nas configurações.',
    'reason.cookies-auth':
      'O site pediu login. Entre no site pelo navegador, feche-o e tente de novo — ou envie um arquivo de cookies nas configurações.',
    'reason.pixiv-auth': 'Pixiv precisa de login. Abra as configurações e toque em Conectar Pixiv.',
    'reason.login-required': 'Este conteúdo exige login. Envie um arquivo de cookies nas configurações.',
    'reason.rate-limited': 'O site limitou as requisições. Tente de novo mais tarde.',
    'reason.unsupported-url': 'Este link não é suportado por este engine. Tente o outro engine.',
    'reason.not-found': 'Conteúdo não encontrado (removido ou link errado).',
    'reason.private': 'Este conteúdo é privado.',
    'reason.geo-blocked': 'Este conteúdo está bloqueado na sua região.',
    'reason.network': 'Falha de rede. Verifique a conexão e tente de novo.'
  },
  {
    en: {
      ok: 'Finished',
      partial: 'Finished with errors',
      empty: 'Nothing downloaded',
      error: 'Failed',
      cancelled: 'Cancelled',
      'reason.engine-missing': 'The engine is not installed. Install the tools in Settings.',
      'reason.spawn-failed': 'Could not start the engine process.',
      'reason.workspace-failed': 'Could not prepare the download’s temporary folder.',
      'reason.cookies-unavailable': 'The chosen cookies file is not available. Upload it again in Settings.',
      'reason.vault-unavailable':
        'The cookie vault is unavailable, so the chosen file could not be used. Download without choosing cookies, or reset the vault in Settings › Cookies by site.',
      'reason.exit-code': 'The engine exited with an error or was stopped before finishing ({detail}). Check the logs.',
      'reason.empty-result': 'Nothing was downloaded or skipped.',
      'reason.unknown': 'Unidentified error. Check the logs.',
      'reason.cookie-copy':
        'Could not copy the browser cookies. Close the browser and try again, or turn off “Use browser cookies” in Settings.',
      'reason.cookies-auth':
        'The site asked for a login. Sign in with your browser, close it and try again — or upload a cookies file in Settings.',
      'reason.pixiv-auth': 'Pixiv needs a login. Open Settings and tap Connect Pixiv.',
      'reason.login-required': 'This content requires a login. Upload a cookies file in Settings.',
      'reason.rate-limited': 'The site is rate limiting requests. Try again later.',
      'reason.unsupported-url': 'This link is not supported by this engine. Try the other engine.',
      'reason.not-found': 'Content not found (removed or wrong link).',
      'reason.private': 'This content is private.',
      'reason.geo-blocked': 'This content is blocked in your region.',
      'reason.network': 'Network error. Check your connection and try again.'
    },
    es: {
      ok: 'Completada',
      partial: 'Completada con errores',
      empty: 'Nada descargado',
      error: 'Falló',
      cancelled: 'Cancelada',
      'reason.engine-missing': 'El engine no está instalado. Instala las herramientas en Ajustes.',
      'reason.spawn-failed': 'No se pudo iniciar el proceso del engine.',
      'reason.workspace-failed': 'No se pudo preparar la carpeta temporal de la descarga.',
      'reason.cookies-unavailable': 'El archivo de cookies elegido no está disponible. Súbelo de nuevo en Ajustes.',
      'reason.vault-unavailable':
        'El almacén de cookies no está disponible, así que no se pudo usar el archivo elegido. Descarga sin elegir cookies o restablece el almacén en Ajustes › Cookies por sitio.',
      'reason.exit-code':
        'El engine terminó con un error o se detuvo antes de terminar ({detail}). Revisa los registros.',
      'reason.empty-result': 'No se descargó ni se omitió ningún archivo.',
      'reason.unknown': 'Error no identificado. Revisa los registros.',
      'reason.cookie-copy':
        'No se pudieron copiar las cookies del navegador. Cierra el navegador e inténtalo de nuevo, o desactiva “Usar cookies del navegador” en Ajustes.',
      'reason.cookies-auth':
        'El sitio pidió iniciar sesión. Entra con tu navegador, ciérralo e inténtalo de nuevo — o sube un archivo de cookies en Ajustes.',
      'reason.pixiv-auth': 'Pixiv necesita iniciar sesión. Abre Ajustes y toca Conectar Pixiv.',
      'reason.login-required': 'Este contenido requiere iniciar sesión. Sube un archivo de cookies en Ajustes.',
      'reason.rate-limited': 'El sitio está limitando las solicitudes. Inténtalo más tarde.',
      'reason.unsupported-url': 'Este engine no admite este enlace. Prueba con el otro engine.',
      'reason.not-found': 'Contenido no encontrado (eliminado o enlace incorrecto).',
      'reason.private': 'Este contenido es privado.',
      'reason.geo-blocked': 'Este contenido está bloqueado en tu región.',
      'reason.network': 'Error de red. Revisa tu conexión e inténtalo de nuevo.'
    }
  }
);

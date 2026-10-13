/** `ui.vault.*` — disabled secret vault: persistent notice, cookies-settings banner, reset feedback. Owner: renderer. */
import { defineMessages } from '../../define.ts';

export const uiVaultMessages = defineMessages(
  {
    'vault.notice.title': 'Cookies e login do Pixiv indisponíveis',
    'vault.notice.message':
      'O Yami não conseguiu abrir o cofre de cookies e login do Pixiv. Downloads e histórico continuam; cookies salvos e Pixiv, não.',
    'vault.banner.title': 'Cofre de cookies indisponível',
    'vault.banner.keystore':
      'O sistema não liberou a chave do cofre — isso acontece, por exemplo, depois de redefinir a senha do Windows ou de perder o chaveiro do sistema. Se o chaveiro só estiver bloqueado, desbloqueie-o e reinicie o Yami.',
    'vault.banner.corrupted': 'O arquivo da chave do cofre está danificado ou incompleto.',
    'vault.banner.io': 'Não foi possível ler ou gravar a chave do cofre (permissão ou erro de disco).',
    'vault.banner.effects':
      'Enquanto isso, os downloads rodam sem os cookies salvos e sem o login do Pixiv; um download com arquivo de cookies escolhido fica pausado (com os arquivos parciais) até o cofre voltar. Redefinir cria um cofre novo e vazio: os cookies salvos e o login do Pixiv são perdidos (o cofre antigo é guardado, não apagado).',
    'vault.reset': 'Redefinir cofre',
    'vault.resetting': 'Redefinindo…',
    'vault.resetDone': 'Cofre redefinido',
    'vault.resetDoneMsg': 'Envie os arquivos de cookies de novo e reconecte o Pixiv.',
    'vault.resetPendingMsg':
      'O motor de downloads ainda está iniciando; o aviso some quando ele terminar. Depois, envie os cookies de novo e reconecte o Pixiv.',
    'vault.recovered': 'Cofre disponível de novo',
    'vault.recoveredMsg': 'A chave voltou a ser lida; nada foi apagado.',
    'vault.resetFail': 'Não foi possível redefinir o cofre'
  },
  {
    en: {
      'vault.notice.title': 'Cookies and Pixiv login unavailable',
      'vault.notice.message':
        'Yami could not open the cookie and Pixiv login vault. Downloads and history continue; stored cookies and Pixiv do not.',
      'vault.banner.title': 'Cookie vault unavailable',
      'vault.banner.keystore':
        'The system did not release the vault key — this happens, for example, after resetting the Windows password or losing the system keyring. If the keyring is only locked, unlock it and restart Yami.',
      'vault.banner.corrupted': 'The vault key file is damaged or incomplete.',
      'vault.banner.io': 'The vault key could not be read or written (permission or disk error).',
      'vault.banner.effects':
        'Meanwhile, downloads run without the stored cookies and without the Pixiv login; a download with a chosen cookie file is paused (keeping its partial files) until the vault works again. Resetting creates a new, empty vault: stored cookies and the Pixiv login are lost (the old vault is kept, not deleted).',
      'vault.reset': 'Reset vault',
      'vault.resetting': 'Resetting…',
      'vault.resetDone': 'Vault reset',
      'vault.resetDoneMsg': 'Upload your cookie files again and reconnect Pixiv.',
      'vault.resetPendingMsg':
        'The download engine is still starting; this notice goes away once it is up. Then upload your cookies again and reconnect Pixiv.',
      'vault.recovered': 'Vault available again',
      'vault.recoveredMsg': 'The key can be read again; nothing was deleted.',
      'vault.resetFail': 'Could not reset the vault'
    },
    es: {
      'vault.notice.title': 'Cookies e inicio de sesión de Pixiv no disponibles',
      'vault.notice.message':
        'Yami no pudo abrir el almacén de cookies e inicio de sesión de Pixiv. Las descargas y el historial continúan; cookies guardadas y Pixiv, no.',
      'vault.banner.title': 'Almacén de cookies no disponible',
      'vault.banner.keystore':
        'El sistema no liberó la clave del almacén; pasa, por ejemplo, tras restablecer la contraseña de Windows o perder el llavero del sistema. Si el llavero solo está bloqueado, desbloquéalo y reinicia Yami.',
      'vault.banner.corrupted': 'El archivo de la clave del almacén está dañado o incompleto.',
      'vault.banner.io': 'No se pudo leer ni escribir la clave del almacén (permisos o error de disco).',
      'vault.banner.effects':
        'Mientras tanto, las descargas funcionan sin las cookies guardadas y sin el inicio de sesión de Pixiv; una descarga con un archivo de cookies elegido queda en pausa (con sus archivos parciales) hasta que el almacén vuelva. Restablecer crea un almacén nuevo y vacío: se pierden las cookies guardadas y el inicio de sesión de Pixiv (el almacén antiguo se guarda, no se borra).',
      'vault.reset': 'Restablecer almacén',
      'vault.resetting': 'Restableciendo…',
      'vault.resetDone': 'Almacén restablecido',
      'vault.resetDoneMsg': 'Vuelve a subir tus archivos de cookies y a conectar Pixiv.',
      'vault.resetPendingMsg':
        'El motor de descargas todavía se está iniciando; este aviso desaparece cuando termine. Después, vuelve a subir las cookies y a conectar Pixiv.',
      'vault.recovered': 'Almacén disponible de nuevo',
      'vault.recoveredMsg': 'La clave se puede leer otra vez; no se borró nada.',
      'vault.resetFail': 'No se pudo restablecer el almacén'
    }
  }
);

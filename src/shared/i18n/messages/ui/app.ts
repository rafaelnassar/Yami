/** `ui.*` — app shell, common words, conversations, files, window and title bar. Owner: renderer. */
import { defineMessages } from '../../define.ts';

export const uiAppMessages = defineMessages(
  {
    'app.name': 'Yami',
    'app.bridgeMissing': 'Esta página precisa ser aberta pelo aplicativo Yami.',

    'common.back': 'Voltar',
    'common.cancel': 'Cancelar',
    'common.close': 'Fechar',
    'common.loading': 'Carregando…',
    'common.loadingMore': 'Carregando mais itens…',
    'common.retry': 'Tentar de novo',
    'common.save': 'Salvar',

    'errors.unknown': 'Algo deu errado.',
    'errorBoundary.title': 'Esta parte da tela parou de funcionar',
    'errorBoundary.message': 'Recarregue este painel para tentar de novo.',
    'errorBoundary.recover': 'Recarregar painel',

    'nsfw.reveal': 'Mostrar',
    'nsfw.revealLabel': 'Conteúdo +18 oculto. Mostrar',
    'nsfw.hiddenHint': 'Clique para revelar nesta visualização.',

    'files.openFail': 'Não foi possível abrir o arquivo',
    'files.revealFail': 'Não foi possível abrir a pasta',
    'files.openLinkFail': 'Não foi possível abrir o link',
    'files.revealedInstead': 'Arquivo mostrado na pasta',
    'files.revealedInsteadMsg': 'Por segurança, este tipo de arquivo não é aberto pelo app.',

    'engine.missing': 'Não instalado',
    'engine.galleryMissingTitle': 'Motor de galerias indisponível',
    'engine.videoMissingTitle': 'Motor de vídeo indisponível',
    'engine.missingMessage': 'Instale as ferramentas em Ajustes.',

    'window.controls': 'Controles da janela',
    'window.minimize': 'Minimizar',
    'window.maximize': 'Maximizar janela',
    'window.restore': 'Restaurar janela',
    'window.close': 'Fechar',
    'window.closeToTray': 'Fechar para a bandeja',
    'window.closeToTrayHint': 'Fechar para a bandeja (o app continua rodando)',

    'titlebar.actions': 'Ações da Yami',
    'titlebar.settings': 'Ajustes',
    'titlebar.logs': 'Registros',
    'titlebar.github': 'Abrir repositório no GitHub',
    'titlebar.sidebarHide': 'Ocultar conversas',
    'titlebar.sidebarShow': 'Mostrar conversas',

    'modal.settings': 'Ajustes',
    'modal.logs': 'Registros',
    'modal.logsAria': 'Registros do motor',

    'conversation.event.created': 'Download criado',
    'conversation.event.started': 'Download iniciado',
    'conversation.event.paused': 'Download pausado',
    'conversation.event.resumed': 'Download retomado',
    'conversation.event.cancelled': 'Download cancelado',
    'conversation.event.restarted': 'Download reiniciado',
    'conversation.event.retry': 'Nova tentativa',
    'conversation.event.completed': 'Download concluído',
    'conversation.event.failed': 'Download falhou',
    'conversation.event.legacy': 'Evento importado'
  },
  {
    en: {
      'app.name': 'Yami',
      'app.bridgeMissing': 'This page must be opened by the Yami app.',

      'common.back': 'Back',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.loading': 'Loading…',
      'common.loadingMore': 'Loading more items…',
      'common.retry': 'Try again',
      'common.save': 'Save',

      'errors.unknown': 'Something went wrong.',
      'errorBoundary.title': 'This part of the screen stopped working',
      'errorBoundary.message': 'Reload this panel to try again.',
      'errorBoundary.recover': 'Reload panel',

      'nsfw.reveal': 'Show',
      'nsfw.revealLabel': 'Adult content hidden. Show',
      'nsfw.hiddenHint': 'Click to reveal in this view.',

      'files.openFail': 'Could not open the file',
      'files.revealFail': 'Could not open the folder',
      'files.openLinkFail': 'Could not open the link',
      'files.revealedInstead': 'File shown in its folder',
      'files.revealedInsteadMsg': 'For safety, the app does not open this type of file.',

      'engine.missing': 'Not installed',
      'engine.galleryMissingTitle': 'Gallery engine unavailable',
      'engine.videoMissingTitle': 'Video engine unavailable',
      'engine.missingMessage': 'Install the tools in Settings.',

      'window.controls': 'Window controls',
      'window.minimize': 'Minimize',
      'window.maximize': 'Maximize window',
      'window.restore': 'Restore window',
      'window.close': 'Close',
      'window.closeToTray': 'Close to tray',
      'window.closeToTrayHint': 'Close to tray (the app keeps running)',

      'titlebar.actions': 'Yami actions',
      'titlebar.settings': 'Settings',
      'titlebar.logs': 'Logs',
      'titlebar.github': 'Open GitHub repository',
      'titlebar.sidebarHide': 'Hide conversations',
      'titlebar.sidebarShow': 'Show conversations',

      'modal.settings': 'Settings',
      'modal.logs': 'Logs',
      'modal.logsAria': 'Engine logs',

      'conversation.event.created': 'Download created',
      'conversation.event.started': 'Download started',
      'conversation.event.paused': 'Download paused',
      'conversation.event.resumed': 'Download resumed',
      'conversation.event.cancelled': 'Download cancelled',
      'conversation.event.restarted': 'Download restarted',
      'conversation.event.retry': 'Retrying',
      'conversation.event.completed': 'Download complete',
      'conversation.event.failed': 'Download failed',
      'conversation.event.legacy': 'Imported event'
    },
    es: {
      'app.name': 'Yami',
      'app.bridgeMissing': 'Esta página debe abrirse desde la app Yami.',

      'common.back': 'Volver',
      'common.cancel': 'Cancelar',
      'common.close': 'Cerrar',
      'common.loading': 'Cargando…',
      'common.loadingMore': 'Cargando más elementos…',
      'common.retry': 'Reintentar',
      'common.save': 'Guardar',

      'errors.unknown': 'Algo salió mal.',
      'errorBoundary.title': 'Esta parte de la pantalla dejó de funcionar',
      'errorBoundary.message': 'Recarga este panel para intentar de nuevo.',
      'errorBoundary.recover': 'Recargar panel',

      'nsfw.reveal': 'Mostrar',
      'nsfw.revealLabel': 'Contenido +18 oculto. Mostrar',
      'nsfw.hiddenHint': 'Haz clic para revelar en esta vista.',

      'files.openFail': 'No se pudo abrir el archivo',
      'files.revealFail': 'No se pudo abrir la carpeta',
      'files.openLinkFail': 'No se pudo abrir el enlace',
      'files.revealedInstead': 'Archivo mostrado en su carpeta',
      'files.revealedInsteadMsg': 'Por seguridad, la app no abre este tipo de archivo.',

      'engine.missing': 'No instalado',
      'engine.galleryMissingTitle': 'Motor de galerías no disponible',
      'engine.videoMissingTitle': 'Motor de vídeo no disponible',
      'engine.missingMessage': 'Instala las herramientas en Ajustes.',

      'window.controls': 'Controles de la ventana',
      'window.minimize': 'Minimizar',
      'window.maximize': 'Maximizar ventana',
      'window.restore': 'Restaurar ventana',
      'window.close': 'Cerrar',
      'window.closeToTray': 'Cerrar a la bandeja',
      'window.closeToTrayHint': 'Cerrar a la bandeja (la app sigue en ejecución)',

      'titlebar.actions': 'Acciones de Yami',
      'titlebar.settings': 'Ajustes',
      'titlebar.logs': 'Registros',
      'titlebar.github': 'Abrir repositorio en GitHub',
      'titlebar.sidebarHide': 'Ocultar conversaciones',
      'titlebar.sidebarShow': 'Mostrar conversaciones',

      'modal.settings': 'Ajustes',
      'modal.logs': 'Registros',
      'modal.logsAria': 'Registros del motor',

      'conversation.event.created': 'Descarga creada',
      'conversation.event.started': 'Descarga iniciada',
      'conversation.event.paused': 'Descarga pausada',
      'conversation.event.resumed': 'Descarga reanudada',
      'conversation.event.cancelled': 'Descarga cancelada',
      'conversation.event.restarted': 'Descarga reiniciada',
      'conversation.event.retry': 'Nuevo intento',
      'conversation.event.completed': 'Descarga completada',
      'conversation.event.failed': 'Descarga fallida',
      'conversation.event.legacy': 'Evento importado'
    }
  }
);

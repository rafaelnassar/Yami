/**
 * Home-screen greetings (rotating headline above the composer), per locale.
 * Not part of the flat catalog: the renderer picks one at random.
 */
import type { Locale } from '../../../contracts/app-settings.ts';

export const UI_GREETINGS: Readonly<Record<Locale, readonly string[]>> = {
  pt: [
    'O que vamos baixar hoje?',
    'Cole um link para começar.',
    'Pronto quando você estiver.',
    'Link único ou lote — você escolhe.',
    'Qual link entra na fila?',
    'Cole o link e deixe rodar.',
    'Fila livre. Pode colar.',
    'Ctrl + V para começar.',
    'Comece com http:// ou https://.',
    'Imagens, vídeos ou um lote inteiro.',
    'Um link basta para começar.',
    'Pronto para o próximo download.',
    'Sem pressa — a fila espera.',
    'Mande o link.',
    'Cole aqui.',
    'Qual site agora?',
    'Lista longa ou link único.',
    'Deixe o endereço aqui.',
    'Transforme o link em arquivos locais.',
    'Qual será o próximo na fila?'
  ],
  en: [
    'What are we downloading today?',
    'Paste a link to get started.',
    'Ready when you are.',
    'Single link or batch — your call.',
    'Which link joins the queue?',
    'Paste the link and let it run.',
    'The queue is free. Paste away.',
    'Ctrl + V to start.',
    'Start with http:// or https://.',
    'Images, videos, or a whole batch.',
    'One link is enough to start.',
    'Ready for the next download.',
    'No rush — the queue can wait.',
    'Send the link.',
    'Paste here.',
    'Which site now?',
    'Long list or single link.',
    'Drop the address here.',
    'Turn that link into local files.',
    'What’s next in the queue?'
  ],
  es: [
    '¿Qué vamos a descargar hoy?',
    'Pega un enlace para empezar.',
    'Listo cuando tú lo estés.',
    'Enlace único o lote — tú eliges.',
    '¿Qué enlace entra en la cola?',
    'Pega el enlace y deja que corra.',
    'Cola libre. Puedes pegar.',
    'Ctrl + V para empezar.',
    'Empieza con http:// o https://.',
    'Imágenes, vídeos o un lote entero.',
    'Un enlace basta para empezar.',
    'Listo para la próxima descarga.',
    'Sin prisa — la cola espera.',
    'Envía el enlace.',
    'Pega aquí.',
    '¿Qué sitio ahora?',
    'Lista larga o un solo enlace.',
    'Deja la dirección aquí.',
    'Convierte el enlace en archivos locales.',
    '¿Qué sigue en la cola?'
  ]
};

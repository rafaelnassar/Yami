/** `notices.<code>.title|message` emitted by the runtime-tools module (owned by host/application/runtime). */
import { defineMessages } from '../define.ts';

export const noticesRuntimeMessages = defineMessages(
  {
    'runtimeUpdatesAvailable.title': 'Atualização disponível',
    'runtimeUpdatesAvailable.message_one': '{name}: {current} → {latest}',
    'runtimeUpdatesAvailable.message_other': '{count} ferramentas prontas: {names}',
    'autoInstallFailed.title': 'Não consegui instalar as ferramentas',
    'autoInstallFailed.message': 'Faltam: {tools}. Verifique a internet e use Instalar em Ajustes.'
  },
  {
    en: {
      'runtimeUpdatesAvailable.title': 'Update available',
      'runtimeUpdatesAvailable.message_one': '{name}: {current} → {latest}',
      'runtimeUpdatesAvailable.message_other': '{count} tools ready: {names}',
      'autoInstallFailed.title': "Couldn't install the tools",
      'autoInstallFailed.message': 'Missing: {tools}. Check your internet connection and use Install in Settings.'
    },
    es: {
      'runtimeUpdatesAvailable.title': 'Actualización disponible',
      'runtimeUpdatesAvailable.message_one': '{name}: {current} → {latest}',
      'runtimeUpdatesAvailable.message_other': '{count} herramientas listas: {names}',
      'autoInstallFailed.title': 'No se pudieron instalar las herramientas',
      'autoInstallFailed.message': 'Faltan: {tools}. Revisa tu conexión y usa Instalar en Ajustes.'
    }
  }
);

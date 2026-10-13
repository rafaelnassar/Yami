/**
 * `notices.<code>.title` / `notices.<code>.message` — notices emitted by the host
 * application services and the host bootstrap (session, library, cookies, settings,
 * accounts, database recovery, legacy 1.x import).
 */
import { defineMessages } from '../define.ts';

export const noticesMessages = defineMessages(
  {
    'databaseRecovered.title': 'Banco de dados recuperado',
    'databaseRecovered.message':
      'O histórico estava corrompido e foi recriado. Recuperamos {conversations} download(s) e {files} arquivo(s); o que não pôde ser lido continua na cópia guardada em {backupPath}.',
    'databaseRecoveredEmpty.title': 'Banco de dados recriado',
    'databaseRecoveredEmpty.message':
      'O histórico estava corrompido e nada pôde ser recuperado, então ele foi recriado vazio. Uma cópia do arquivo antigo foi guardada em {backupPath}.',
    'legacySecretsKept.title': 'Arquivos antigos com senhas ou cookies',
    'legacySecretsKept.message':
      '{count} arquivo(s) de cookies ou credenciais da versão anterior continuam sem criptografia em {legacyDir}. Revise e apague se não precisar mais.',
    'legacySecretsRemoved.title': 'Senhas e cookies antigos protegidos',
    'legacySecretsRemoved.message':
      '{count} arquivo(s) de cookies ou credenciais da versão anterior foram criptografados no cofre do Yami e apagados de {legacyDir}, onde ficavam sem proteção.',
    'legacyImportRetry.title': 'Importação da versão anterior incompleta',
    'legacyImportRetry.message':
      'Parte dos dados da versão anterior não pôde ser importada (etapas: {steps}). O Yami vai tentar de novo na próxima vez que abrir (tentativa {attempt} de {maxAttempts}).',
    'legacyImportFailed.title': 'Importação da versão anterior com falhas',
    'legacyImportFailed.message':
      'Parte dos dados da versão anterior não pôde ser importada (etapas: {steps}) e não haverá nova tentativa. O histórico original continua em {legacyDir}.',
    'legacyImportDeferred.title': 'Importação da versão anterior adiada',
    'legacyImportDeferred.message':
      'Os dados da versão anterior em {legacyDir} (histórico, cookies e login do Pixiv) serão importados quando o cofre de cookies voltar a funcionar. Nada foi alterado nessa pasta.'
  },
  {
    en: {
      'databaseRecovered.title': 'Database recovered',
      'databaseRecovered.message':
        'The history was corrupted and has been recreated. {conversations} download(s) and {files} file(s) were recovered; anything that could not be read is still in the copy kept at {backupPath}.',
      'databaseRecoveredEmpty.title': 'Database recreated',
      'databaseRecoveredEmpty.message':
        'The history was corrupted and nothing could be recovered, so it was recreated empty. A copy of the old file was kept at {backupPath}.',
      'legacySecretsKept.title': 'Old files with passwords or cookies',
      'legacySecretsKept.message':
        '{count} cookie or credential file(s) from the previous version are still unencrypted in {legacyDir}. Review and delete them if you no longer need them.',
      'legacySecretsRemoved.title': 'Old passwords and cookies protected',
      'legacySecretsRemoved.message':
        "{count} cookie or credential file(s) from the previous version were encrypted into Yami's vault and deleted from {legacyDir}, where they were stored unprotected.",
      'legacyImportRetry.title': 'Import from the previous version incomplete',
      'legacyImportRetry.message':
        'Some data from the previous version could not be imported (steps: {steps}). Yami will try again the next time it starts (attempt {attempt} of {maxAttempts}).',
      'legacyImportFailed.title': 'Import from the previous version had errors',
      'legacyImportFailed.message':
        'Some data from the previous version could not be imported (steps: {steps}) and will not be retried. The original history is still in {legacyDir}.',
      'legacyImportDeferred.title': 'Import from the previous version postponed',
      'legacyImportDeferred.message':
        'The data from the previous version in {legacyDir} (history, cookies and Pixiv login) will be imported once the cookie vault works again. Nothing in that folder was changed.'
    },
    es: {
      'databaseRecovered.title': 'Base de datos recuperada',
      'databaseRecovered.message':
        'El historial estaba dañado y se volvió a crear. Se recuperaron {conversations} descarga(s) y {files} archivo(s); lo que no se pudo leer sigue en la copia guardada en {backupPath}.',
      'databaseRecoveredEmpty.title': 'Base de datos recreada',
      'databaseRecoveredEmpty.message':
        'El historial estaba dañado y no se pudo recuperar nada, así que se volvió a crear vacío. Se guardó una copia del archivo anterior en {backupPath}.',
      'legacySecretsKept.title': 'Archivos antiguos con contraseñas o cookies',
      'legacySecretsKept.message':
        '{count} archivo(s) de cookies o credenciales de la versión anterior siguen sin cifrar en {legacyDir}. Revísalos y bórralos si ya no los necesitas.',
      'legacySecretsRemoved.title': 'Contraseñas y cookies antiguas protegidas',
      'legacySecretsRemoved.message':
        'Se cifraron {count} archivo(s) de cookies o credenciales de la versión anterior en el almacén de Yami y se borraron de {legacyDir}, donde estaban sin protección.',
      'legacyImportRetry.title': 'Importación de la versión anterior incompleta',
      'legacyImportRetry.message':
        'No se pudo importar parte de los datos de la versión anterior (pasos: {steps}). Yami lo intentará de nuevo la próxima vez que se abra (intento {attempt} de {maxAttempts}).',
      'legacyImportFailed.title': 'Importación de la versión anterior con errores',
      'legacyImportFailed.message':
        'No se pudo importar parte de los datos de la versión anterior (pasos: {steps}) y no se volverá a intentar. El historial original sigue en {legacyDir}.',
      'legacyImportDeferred.title': 'Importación de la versión anterior aplazada',
      'legacyImportDeferred.message':
        'Los datos de la versión anterior en {legacyDir} (historial, cookies e inicio de sesión de Pixiv) se importarán cuando el almacén de cookies vuelva a funcionar. No se modificó nada en esa carpeta.'
    }
  }
);

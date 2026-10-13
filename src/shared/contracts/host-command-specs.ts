/**
 * Part of the host protocol (main ↔ download host utility process).
 * See `host-protocol.ts` for the transport overview.
 */
import type { Schema } from '../validation/schema.ts';
import { Schemas } from './host-command-schemas.ts';
import {
  MAIN_ONLY_COMMANDS,
  type CommandAudience,
  type CommandPayload,
  type HostCommand,
  type RendererHostCommand
} from './host-commands.ts';

export interface CommandSpec<C extends HostCommand> {
  readonly schema: Schema<CommandPayload<C>>;
  readonly timeoutMs: number;
}

const DEFAULT_TIMEOUT = 15_000;

const spec = <C extends HostCommand>(
  schema: Schema<CommandPayload<C>>,
  timeoutMs = DEFAULT_TIMEOUT
): CommandSpec<C> => ({
  schema,
  timeoutMs
});

export const COMMAND_SPECS: { readonly [C in HostCommand]: CommandSpec<C> } = {
  'session.init': spec(Schemas.empty, 30_000),

  'downloads.start': spec(Schemas.start),
  'downloads.pause': spec(Schemas.conversationRef, 30_000),
  'downloads.resume': spec(Schemas.conversationRef, 30_000),
  'downloads.stop': spec(Schemas.conversationRef, 30_000),
  'downloads.restart': spec(Schemas.conversationRef, 30_000),
  'downloads.pauseAll': spec(Schemas.empty, 60_000),
  'downloads.resumeAll': spec(Schemas.empty, 60_000),
  'downloads.stopAll': spec(Schemas.empty, 60_000),

  'conversations.list': spec(Schemas.listConversations),
  'conversations.get': spec(Schemas.conversationRef),
  'conversations.files': spec(Schemas.conversationFiles),
  'conversations.rename': spec(Schemas.renameConversation),
  'conversations.delete': spec(Schemas.deleteConversation, 120_000),
  'conversations.moveToFolder': spec(Schemas.moveToFolder),

  'folders.list': spec(Schemas.empty),
  'folders.create': spec(Schemas.createFolder),
  'folders.update': spec(Schemas.updateFolder),
  'folders.delete': spec(Schemas.folderRef),

  'files.delete': spec(Schemas.deleteFiles, 120_000),
  'files.inspect': spec(Schemas.inspectFile),

  'cookies.list': spec(Schemas.empty),
  'cookies.upload': spec(Schemas.uploadCookies),
  'cookies.select': spec(Schemas.selectCookies),
  'cookies.delete': spec(Schemas.cookieRef),
  'cookies.setBindings': spec(Schemas.setCookieBindings),
  'cookies.setFromBrowser': spec(Schemas.setFromBrowser),

  'settings.setDefaultEngine': spec(Schemas.setDefaultEngine),

  'runtime.setMode': spec(Schemas.setRuntimeMode),
  'runtime.dismissSetup': spec(Schemas.empty),
  'runtime.install': spec(Schemas.installRuntime),
  'runtime.update': spec(Schemas.updateRuntime),
  'runtime.checkUpdates': spec(Schemas.empty),

  'notices.clearError': spec(Schemas.empty),
  'logs.recent': spec(Schemas.empty),

  'system.configure': spec(Schemas.configure, 60_000),
  'settings.setDownloadDir': spec(Schemas.setDownloadDir),
  'accounts.pixiv.save': spec(Schemas.savePixivAccount),
  'accounts.pixiv.clear': spec(Schemas.empty),
  'accounts.site.save': spec(Schemas.saveSiteAccount),
  'accounts.site.clear': spec(Schemas.siteRef),
  'downloads.history': spec(Schemas.downloadHistory),
  'legacy.importUiData': spec(Schemas.importLegacyUiData, 60_000),
  'lifecycle.shutdown': spec(Schemas.shutdown, 20_000)
};

export const HOST_COMMANDS = Object.keys(COMMAND_SPECS) as HostCommand[];

const MAIN_ONLY = new Set<string>(MAIN_ONLY_COMMANDS);

export function isHostCommand(value: unknown): value is HostCommand {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COMMAND_SPECS, value);
}

export function commandAudience(command: HostCommand): CommandAudience {
  return MAIN_ONLY.has(command) ? 'main' : 'renderer';
}

export function isRendererCommand(command: unknown): command is RendererHostCommand {
  return isHostCommand(command) && !MAIN_ONLY.has(command);
}

/**
 * Entry point of the download host (Electron `utilityProcess`).
 *
 * Lifecycle: post `ready` → wait for `system.configure` (every other command is
 * refused with HOST_UNAVAILABLE) → build the container and run start-up work →
 * serve commands → `lifecycle.shutdown` stops downloads, closes resources and exits.
 */
import process from 'node:process';
import { ErrorCode, appError, toAppErrorData } from '../../shared/kernel/errors.ts';
import { err, ok } from '../../shared/kernel/result.ts';
import type { HostCommand } from '../../shared/contracts/host-protocol.ts';
import type { Logger, LogFields } from '../application/ports/system.ts';
import { CommandRouter, type CommandHandlers } from '../interface/command-router.ts';
import { EventDispatcher } from '../interface/event-dispatcher.ts';
import { createHandlerTable, type LifecycleHandlers } from '../interface/handler-table.ts';
import { ParentPortTransport, type ParentPortLike } from '../interface/transport.ts';
import { createHostContainer, type HostContainer } from './container.ts';

type Phase = 'awaiting-config' | 'configuring' | 'ready' | 'failed' | 'stopping' | 'stopped';

/** Commands that never change host state (no state broadcast after them). */
const READ_ONLY: ReadonlySet<HostCommand> = new Set<HostCommand>([
  'session.init',
  'conversations.list',
  'conversations.get',
  'conversations.files',
  'folders.list',
  'files.inspect',
  'cookies.list',
  'logs.recent',
  'downloads.history'
]);

/** Logger used before configuration (stderr is piped into main.log by the main process). */
function stderrLogger(bindings: LogFields = {}): Logger {
  const write = (level: string, message: string, fields?: LogFields): void => {
    process.stderr.write(
      `${new Date().toISOString()} ${level} ${message} ${JSON.stringify({ ...bindings, ...fields })}\n`
    );
  };
  return {
    debug: () => undefined,
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (more) => stderrLogger({ ...bindings, ...more })
  };
}

function resolveParentPort(): ParentPortLike | null {
  const candidate: unknown = Reflect.get(process, 'parentPort');
  if (typeof candidate !== 'object' || candidate === null) return null;
  const port = candidate as Partial<ParentPortLike>;
  return typeof port.on === 'function' && typeof port.postMessage === 'function' ? (port as ParentPortLike) : null;
}

function main(): void {
  const port = resolveParentPort();
  if (!port) {
    process.stderr.write('The Yami host must run as an Electron utility process.\n');
    process.exit(1);
  }
  const transport = new ParentPortTransport(port);
  const dispatcher = new EventDispatcher((message) => transport.send(message));
  const bootLogger = stderrLogger({ process: 'host' });

  let phase: Phase = 'awaiting-config';
  let container: HostContainer | null = null;
  let handlers: CommandHandlers | null = null;
  const logger = (): Logger => container?.logger ?? bootLogger;
  /** Commands being handled right now (shutdown waits for them before closing the database). */
  const inFlight = new Set<Promise<unknown>>();
  const drainInFlight = async (deadlineMs: number): Promise<void> => {
    const pending = [...inFlight];
    if (pending.length === 0) return;
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, deadlineMs))]);
  };

  const lifecycle: LifecycleHandlers = {
    configure: async (payload) => {
      if (phase !== 'awaiting-config')
        return err(appError(ErrorCode.VALIDATION_FAILED, { path: 'already-configured' }));
      phase = 'configuring';
      try {
        const built = await createHostContainer(payload, dispatcher);
        container = built;
        await built.start();
        handlers = createHandlerTable(built.services, lifecycle);
        phase = 'ready';
        logger().info('host ready');
        return ok({ state: built.services.projectState() });
      } catch (thrown) {
        phase = 'failed';
        const detail = thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown);
        logger().error('configuration failed', { detail });
        return err(toAppErrorData(thrown));
      }
    },
    shutdown: async ({ mode }) => {
      if (phase === 'stopping' || phase === 'stopped') return ok({});
      const current = container;
      // The gate refuses new commands from now on; let in-flight ones finish (bounded) so
      // e.g. a delete does not lose its database writes when the connection closes.
      phase = 'stopping';
      try {
        await drainInFlight(3_000);
        if (current) await current.shutdown(mode);
      } finally {
        dispatcher.close();
        phase = 'stopped';
        // Let the response reach main before exiting.
        setTimeout(() => process.exit(0), 50);
      }
      return ok({});
    }
  };

  const router = new CommandRouter({
    handlers: () => handlers ?? { 'system.configure': lifecycle.configure, 'lifecycle.shutdown': lifecycle.shutdown },
    gate: (command) => {
      if (command === 'system.configure' || command === 'lifecycle.shutdown') return null;
      if (phase === 'ready') return null;
      if (phase === 'stopping' || phase === 'stopped') return appError(ErrorCode.HOST_SHUTTING_DOWN);
      return appError(ErrorCode.HOST_UNAVAILABLE);
    },
    logger: bootLogger,
    onSuccess: (command) => {
      if (phase === 'ready' && !READ_ONLY.has(command)) container?.statePublisher.stateChanged();
    }
  });

  transport.onMessage((data) => {
    const handled = router.handle(data).then((response) => {
      if (response) transport.send(response);
    });
    // The shutdown command itself is not awaited by the drain (it would wait for itself).
    const isShutdown = (data as { command?: unknown } | null)?.command === 'lifecycle.shutdown';
    if (!isShutdown) {
      inFlight.add(handled);
      void handled.finally(() => inFlight.delete(handled));
    }
  });

  process.on('uncaughtException', (error) => {
    logger().error('uncaught exception', { error: error.stack ?? error.message });
    container?.logger.flushSync();
    // Main restarts the host with backoff; engines keep running and are re-attached.
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger().error('unhandled rejection', {
      reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    });
  });

  transport.send({ kind: 'ready', pid: process.pid });
}

main();

/**
 * Registers IPC handlers behind one policy: the sender must be trusted (see
 * `sender-policy.ts`), arguments are validated by the controllers with `v.*` schemas, and
 * every exception is caught. Invoke channels that return `IpcResult` never reject, so
 * errors keep their `code`/`params` across IPC (no "Error invoking remote method" text).
 */
import type { AppView, IpcResult } from '../../shared/contracts/ipc.ts';
import { ErrorCode, appError, toAppErrorData, type AppErrorData } from '../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../shared/kernel/result.ts';
import type { Schema } from '../../shared/validation/schema.ts';
import { describeError, type Logger } from '../infrastructure/logger.ts';
import type { SenderFrameLike } from '../security/sender-policy.ts';

export interface IpcEventLike {
  readonly sender: { readonly id: number };
  readonly senderFrame: SenderFrameLike | null;
}

/** The subset of Electron's `ipcMain` used by the router (injected for tests). */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
  removeAllListeners(channel?: string): unknown;
}

export interface IpcContext {
  readonly view: AppView;
  readonly webContentsId: number;
}

export interface IpcRouterDeps {
  readonly resolveSender: (event: IpcEventLike) => AppView | null;
  readonly logger: Logger;
}

type Awaitable<T> = T | Promise<T>;

export function toIpcResult<T>(result: Result<T, AppErrorData>): IpcResult<T> {
  return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.error };
}

/** Validates an IPC argument; failures become `VALIDATION_FAILED {path}`. */
export function parseArg<T>(schema: Schema<T>, arg: unknown): Result<T, AppErrorData> {
  const parsed = schema.parse(arg);
  return parsed.ok
    ? ok(parsed.value)
    : err(appError(ErrorCode.VALIDATION_FAILED, { path: parsed.error.path || 'payload' }));
}

export class IpcRouter {
  readonly #ipc: IpcMainLike;
  readonly #deps: IpcRouterDeps;
  readonly #handles = new Set<string>();
  readonly #listeners = new Set<string>();

  constructor(ipc: IpcMainLike, deps: IpcRouterDeps) {
    this.#ipc = ipc;
    this.#deps = deps;
  }

  /** Invoke channel resolving to `IpcResult<T>` (never rejects). */
  handleResult<T>(channel: string, handler: (ctx: IpcContext, arg: unknown) => Awaitable<IpcResult<T>>): void {
    this.#register(channel);
    this.#ipc.handle(channel, async (event, arg) => {
      const ctx = this.#context(channel, event);
      if (!ctx) return { ok: false, error: appError(ErrorCode.IPC_UNAUTHORIZED) } satisfies IpcResult<T>;
      try {
        return await handler(ctx, arg);
      } catch (error) {
        this.#deps.logger.error(`ipc ${channel} failed`, describeError(error));
        return { ok: false, error: toAppErrorData(error) } satisfies IpcResult<T>;
      }
    });
  }

  /** Invoke channel resolving to a plain value (status/info getters); rejects when untrusted. */
  handleValue<T>(channel: string, handler: (ctx: IpcContext, arg: unknown) => Awaitable<T>): void {
    this.#register(channel);
    this.#ipc.handle(channel, async (event, arg) => {
      const ctx = this.#context(channel, event);
      if (!ctx) throw new Error(ErrorCode.IPC_UNAUTHORIZED);
      try {
        return await handler(ctx, arg);
      } catch (error) {
        this.#deps.logger.error(`ipc ${channel} failed`, describeError(error));
        throw new Error(ErrorCode.INTERNAL);
      }
    });
  }

  /** Fire-and-forget channel; untrusted senders are ignored. */
  on(channel: string, handler: (ctx: IpcContext, arg: unknown) => Awaitable<void>): void {
    this.#listeners.add(channel);
    this.#ipc.on(channel, (event, arg) => {
      const ctx = this.#context(channel, event);
      if (!ctx) return;
      Promise.resolve()
        .then(() => handler(ctx, arg))
        .catch((error: unknown) => this.#deps.logger.error(`ipc ${channel} failed`, describeError(error)));
    });
  }

  dispose(): void {
    for (const channel of this.#handles) this.#ipc.removeHandler(channel);
    for (const channel of this.#listeners) this.#ipc.removeAllListeners(channel);
    this.#handles.clear();
    this.#listeners.clear();
  }

  #register(channel: string): void {
    if (this.#handles.has(channel)) throw new Error(`IPC channel registered twice: ${channel}`);
    this.#handles.add(channel);
  }

  #context(channel: string, event: IpcEventLike): IpcContext | null {
    let view: AppView | null = null;
    try {
      view = this.#deps.resolveSender(event);
    } catch {
      // Electron throws when a disposed frame is accessed: treat it as untrusted.
      view = null;
    }
    if (!view) {
      this.#deps.logger.warn('untrusted IPC sender rejected', { channel, webContentsId: event.sender.id });
      return null;
    }
    return { view, webContentsId: event.sender.id };
  }
}

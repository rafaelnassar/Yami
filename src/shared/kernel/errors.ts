/**
 * Application error model.
 *
 * Errors cross process boundaries (host → main → renderer) as plain data
 * (`AppErrorData`). They carry a stable `code` and structured `params`; the UI
 * turns them into localized text through the i18n dictionaries
 * (`errors.<CODE>` keys). No user-facing text is produced outside the UI layer.
 */

export const ErrorCode = {
  // Generic
  INTERNAL: 'INTERNAL',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  CANCELLED: 'CANCELLED',

  // Transport / process boundaries
  IPC_UNAUTHORIZED: 'IPC_UNAUTHORIZED',
  HOST_UNAVAILABLE: 'HOST_UNAVAILABLE',
  HOST_TIMEOUT: 'HOST_TIMEOUT',
  HOST_RESTARTING: 'HOST_RESTARTING',

  // Downloads
  URL_INVALID: 'URL_INVALID',
  URL_PROTOCOL_NOT_ALLOWED: 'URL_PROTOCOL_NOT_ALLOWED',
  URL_LIMIT_EXCEEDED: 'URL_LIMIT_EXCEEDED',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  DOWNLOAD_NOT_ACTIVE: 'DOWNLOAD_NOT_ACTIVE',
  DOWNLOAD_NOT_PAUSED: 'DOWNLOAD_NOT_PAUSED',
  DOWNLOAD_STILL_ACTIVE: 'DOWNLOAD_STILL_ACTIVE',
  DOWNLOAD_INVALID_TRANSITION: 'DOWNLOAD_INVALID_TRANSITION',
  PROCESS_KILL_FAILED: 'PROCESS_KILL_FAILED',
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  TITLE_REQUIRED: 'TITLE_REQUIRED',
  HOST_SHUTTING_DOWN: 'HOST_SHUTTING_DOWN',

  // Files / library
  PATH_INVALID: 'PATH_INVALID',
  PATH_OUTSIDE_SANDBOX: 'PATH_OUTSIDE_SANDBOX',
  PATH_NOT_FOUND: 'PATH_NOT_FOUND',
  DOWNLOAD_DIR_FORBIDDEN: 'DOWNLOAD_DIR_FORBIDDEN',
  FILE_OPEN_BLOCKED: 'FILE_OPEN_BLOCKED',
  FILE_OPERATION_FAILED: 'FILE_OPERATION_FAILED',
  FOLDER_NAME_INVALID: 'FOLDER_NAME_INVALID',
  FOLDER_ALREADY_EXISTS: 'FOLDER_ALREADY_EXISTS',
  FOLDER_NOT_FOUND: 'FOLDER_NOT_FOUND',

  // Cookies / accounts
  COOKIES_INVALID_NAME: 'COOKIES_INVALID_NAME',
  COOKIES_INVALID_FORMAT: 'COOKIES_INVALID_FORMAT',
  COOKIES_TOO_LARGE: 'COOKIES_TOO_LARGE',
  COOKIES_NOT_FOUND: 'COOKIES_NOT_FOUND',
  OAUTH_LOGIN_IN_PROGRESS: 'OAUTH_LOGIN_IN_PROGRESS',
  OAUTH_LOGIN_CANCELLED: 'OAUTH_LOGIN_CANCELLED',
  OAUTH_LOGIN_FAILED: 'OAUTH_LOGIN_FAILED',
  PIXIV_LOGIN_IN_PROGRESS: 'PIXIV_LOGIN_IN_PROGRESS',
  PIXIV_LOGIN_CANCELLED: 'PIXIV_LOGIN_CANCELLED',
  PIXIV_LOGIN_FAILED: 'PIXIV_LOGIN_FAILED',
  VAULT_UNAVAILABLE: 'VAULT_UNAVAILABLE',

  // Runtime tools
  TOOLS_BUSY: 'TOOLS_BUSY',
  TOOLS_DOWNLOADS_ACTIVE: 'TOOLS_DOWNLOADS_ACTIVE',
  TOOLS_INSTALL_FAILED: 'TOOLS_INSTALL_FAILED',
  TOOLS_INTEGRITY_FAILED: 'TOOLS_INTEGRITY_FAILED',
  TOOLS_NOT_PINNED: 'TOOLS_NOT_PINNED',
  TOOLS_UNSUPPORTED_PLATFORM: 'TOOLS_UNSUPPORTED_PLATFORM',
  TOOLS_NETWORK_FAILED: 'TOOLS_NETWORK_FAILED',

  // Persistence
  /** The database was written by a newer build (`params.version` > `params.known`); the host refuses to open it. */
  DATABASE_TOO_NEW: 'DATABASE_TOO_NEW',

  // App / updates
  UPDATE_UNAVAILABLE: 'UPDATE_UNAVAILABLE',
  UPDATE_FAILED: 'UPDATE_FAILED'
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type ErrorParamValue = string | number | boolean | null;
export type ErrorParams = Readonly<Record<string, ErrorParamValue>>;

/** Serializable error shape that crosses process boundaries. */
export interface AppErrorData {
  readonly code: ErrorCode;
  readonly params?: ErrorParams;
}

/** Throwable/returnable error inside a process. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams | undefined;

  constructor(code: ErrorCode, params?: ErrorParams, options?: { cause?: unknown }) {
    super(params?.['detail'] ? `${code}: ${String(params['detail'])}` : code, options);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
  }

  toData(): AppErrorData {
    return this.params ? { code: this.code, params: this.params } : { code: this.code };
  }
}

export function appError(code: ErrorCode, params?: ErrorParams): AppErrorData {
  return params ? { code, params } : { code };
}

const ERROR_CODES = new Set<string>(Object.values(ErrorCode));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

export function isAppErrorData(value: unknown): value is AppErrorData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; params?: unknown };
  if (!isErrorCode(candidate.code)) return false;
  return candidate.params === undefined || (typeof candidate.params === 'object' && candidate.params !== null);
}

/**
 * Normalizes anything thrown into `AppErrorData`. Unknown errors become
 * `INTERNAL` with a short, non-sensitive detail string.
 */
export function toAppErrorData(error: unknown): AppErrorData {
  if (error instanceof AppError) return error.toData();
  if (isAppErrorData(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return { code: ErrorCode.INTERNAL, params: { detail: detail.slice(0, 500) } };
}

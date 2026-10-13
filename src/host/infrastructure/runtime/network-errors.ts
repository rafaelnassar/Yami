/**
 * Maps low-level network/file errors to `AppErrorData` (+ whether a retry makes sense).
 */
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { HttpError } from './https-client.ts';

export interface ClassifiedError {
  readonly error: AppErrorData;
  readonly retryable: boolean;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET'
]);

function errnoCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Unwraps `AbortError` (stream.pipeline with a signal) to the abort reason. */
function rootCause(error: unknown): unknown {
  if (error instanceof Error && error.name === 'AbortError' && error.cause !== undefined) return error.cause;
  return error;
}

export function classifyError(tool: string, error: unknown, cancelled: boolean): ClassifiedError {
  if (cancelled) return { error: { code: ErrorCode.CANCELLED }, retryable: false };
  const cause = rootCause(error);
  if (cause instanceof HttpError) {
    switch (cause.kind) {
      case 'http-status': {
        const status = cause.status ?? 0;
        const retryable = status === 408 || status === 429 || status >= 500;
        return {
          error: { code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool, detail: `HTTP ${status}` } },
          retryable
        };
      }
      case 'timeout':
      case 'idle-timeout':
      case 'incomplete':
        return {
          error: { code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool, detail: cause.kind } },
          retryable: true
        };
      case 'size-mismatch':
        return { error: { code: ErrorCode.TOOLS_INTEGRITY_FAILED, params: { tool } }, retryable: false };
      case 'too-large':
        return {
          error: { code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool, detail: 'download exceeds the size limit' } },
          retryable: false
        };
      default:
        return {
          error: { code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool, detail: cause.kind } },
          retryable: false
        };
    }
  }
  const code = errnoCode(cause) ?? errnoCode(error);
  if (code && TRANSIENT_CODES.has(code)) {
    return { error: { code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool, detail: code } }, retryable: true };
  }
  if (code && /^(ERR_TLS|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED)/.test(code)) {
    return { error: { code: ErrorCode.TOOLS_NETWORK_FAILED, params: { tool, detail: code } }, retryable: false };
  }
  const detail = code ?? (cause instanceof Error ? cause.message : String(cause));
  return {
    error: { code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool, detail: detail.slice(0, 200) } },
    retryable: false
  };
}

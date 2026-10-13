/**
 * Shape checks for messages coming from the host utility process. The host is our own
 * code, but a crash mid-write or a version mismatch must never throw inside main.
 */
import { isAppErrorData, type AppErrorData } from '../../shared/kernel/errors.ts';
import type { HostEvent } from '../../shared/contracts/host-protocol.ts';

export type ParsedHostMessage =
  | { readonly kind: 'ready'; readonly pid: number }
  | { readonly kind: 'response'; readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly kind: 'response'; readonly id: string; readonly ok: false; readonly error: AppErrorData }
  | { readonly kind: 'event'; readonly event: HostEvent };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHostMessage(raw: unknown): ParsedHostMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw['kind']) {
    case 'ready':
      return { kind: 'ready', pid: typeof raw['pid'] === 'number' ? raw['pid'] : -1 };
    case 'response': {
      const id = raw['id'];
      if (typeof id !== 'string' || id.length === 0) return null;
      if (raw['ok'] === true) return { kind: 'response', id, ok: true, data: raw['data'] };
      const error = isAppErrorData(raw['error'])
        ? raw['error']
        : { code: 'INTERNAL' as const, params: { detail: 'malformed host error' } };
      return { kind: 'response', id, ok: false, error };
    }
    case 'event': {
      const event = raw['event'];
      if (!isRecord(event) || typeof event['type'] !== 'string') return null;
      // Trusted producer (our host bundle); only the discriminant is checked here.
      return { kind: 'event', event: event as HostEvent };
    }
    default:
      return null;
  }
}

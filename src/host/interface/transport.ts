/**
 * Transport between the host (Electron utilityProcess) and the main process.
 * In production this is `process.parentPort` (a MessagePort: structured clone,
 * no framing, no size limit issues); tests use an in-memory fake.
 */
import type { HostToMainMessage } from '../../shared/contracts/host-protocol.ts';

/** Minimal shape of Electron's `process.parentPort` (kept local: the host must not import `electron`). */
export interface ParentPortLike {
  on(event: 'message', listener: (message: { readonly data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

export interface HostTransport {
  send(message: HostToMainMessage): void;
  onMessage(handler: (data: unknown) => void): void;
}

export class ParentPortTransport implements HostTransport {
  readonly #port: ParentPortLike;

  constructor(port: ParentPortLike) {
    this.#port = port;
  }

  send(message: HostToMainMessage): void {
    this.#port.postMessage(message);
  }

  onMessage(handler: (data: unknown) => void): void {
    this.#port.on('message', (message) => handler(message.data));
  }
}

/**
 * The host utility process behind a small interface, so `HostClient` can be tested with
 * a fake (see `utility-host-process.ts` for the Electron implementation).
 */
import type { RawRequestEnvelope } from '../../shared/contracts/host-protocol.ts';

export interface HostProcess {
  readonly pid: number | undefined;
  postMessage(message: RawRequestEnvelope): void;
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
}

export type HostProcessFactory = () => HostProcess;

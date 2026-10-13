/**
 * Electron implementation of `HostProcess`: forks `host.cjs` (next to `main.cjs`) with
 * `utilityProcess` — no `ELECTRON_RUN_AS_NODE`, so the RunAsNode fuse can stay off.
 * The host's stdout/stderr lines go to the main logger.
 */
import { createInterface } from 'node:readline';
import { utilityProcess } from 'electron';
import type { Logger } from '../infrastructure/logger.ts';
import type { HostProcessFactory } from './host-process.ts';

export interface ForkHostOptions {
  readonly modulePath: string;
  readonly logger: Logger;
}

function pipeLines(stream: NodeJS.ReadableStream | null, log: (line: string) => void): void {
  if (!stream) return;
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on('line', (line) => {
    if (line.trim()) log(line);
  });
}

export function createUtilityHostFactory(options: ForkHostOptions): HostProcessFactory {
  return () => {
    const child = utilityProcess.fork(options.modulePath, [], {
      serviceName: 'Yami Download Host',
      stdio: 'pipe'
    });
    const log = options.logger;
    pipeLines(child.stdout, (line) => log.info(line));
    pipeLines(child.stderr, (line) => log.warn(line));
    return {
      get pid() {
        return child.pid;
      },
      postMessage: (message) => child.postMessage(message),
      kill: () => {
        child.kill();
      },
      onMessage: (listener) => {
        child.on('message', (message: unknown) => listener(message));
      },
      onExit: (listener) => {
        child.on('exit', listener);
      }
    };
  };
}

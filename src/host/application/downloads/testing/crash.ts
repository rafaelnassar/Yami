/**
 * Host-crash scenarios: a first host starts a download and is abandoned; a
 * second host over the same database (and engine logs) takes over.
 */
import type { DownloadCoordinatorOptionsInput } from '../coordinator-deps.ts';
import { out } from './fake-engines.ts';
import { FakeLogStore } from './fake-logs.ts';
import { InMemoryPersistence } from './fake-persistence.ts';
import { FakeProcessHost } from './fake-processes.ts';
import { DownloadsHarness } from './harness.ts';

export interface Crashed {
  readonly persistence: InMemoryPersistence;
  readonly logs: FakeLogStore;
  readonly id: string;
  readonly pid: number;
  readonly logFile: string;
}

/** Starts a download in a first host, lets it progress, then abandons that host (crash). */
export async function crashedHost(
  lines: readonly string[] = [out.file('/dl/a.jpg')],
  options: Partial<DownloadCoordinatorOptionsInput> = { persistEveryMs: 0 }
): Promise<Crashed> {
  const persistence = new InMemoryPersistence();
  const logs = new FakeLogStore();
  const first = new DownloadsHarness({ persistence, logs, options });
  const { conversationIds } = await first.startOk(['https://site.com/a']);
  const process = first.processes.last();
  process.write(...lines);
  await first.tick();
  const id = conversationIds[0] ?? '';
  return { persistence, logs, id, pid: process.identity.pid, logFile: process.spec.logFile };
}

export function secondHost(
  crashed: Crashed,
  settings: { readonly alive: boolean; readonly stale?: number },
  options: Partial<DownloadCoordinatorOptionsInput> = {}
): DownloadsHarness {
  const processes = new FakeProcessHost(crashed.logs);
  processes.external.set(crashed.pid, settings.alive);
  return new DownloadsHarness({
    persistence: crashed.persistence,
    logs: crashed.logs,
    processes,
    options: { staleStrictCheckPolls: settings.stale ?? 8, persistEveryMs: 0, ...options }
  });
}

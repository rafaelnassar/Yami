/**
 * Decides whether what the OS reports for a PID is still the process we launched.
 * Unknown data is a match; only positive evidence of a different process is a
 * mismatch — otherwise a backend change (legacy wmic → PowerShell) would orphan
 * every running download.
 */
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { ProcessIdentity } from '../../domain/processes/process-identity.ts';
import type { ProcessSnapshot } from './process-snapshot.ts';
import { isNormalizedCreationDate } from './windows-process-query.ts';

/** Linux truncates `/proc/<pid>/comm` to 15 bytes (TASK_COMM_LEN - 1). */
const LINUX_COMM_LENGTH = 15;

export function imageNamesMatch(expected: string, current: string, platform: HostPlatform): boolean {
  const a = expected.toLowerCase();
  const b = current.toLowerCase();
  if (a === b) return true;
  if (platform === 'linux' && (a.length >= LINUX_COMM_LENGTH || b.length >= LINUX_COMM_LENGTH)) {
    return a.slice(0, LINUX_COMM_LENGTH) === b.slice(0, LINUX_COMM_LENGTH);
  }
  return false;
}

/**
 * Tokens are comparable only when both come from the same source. For
 * `powershell`, legacy tokens were raw `.Ticks`; only tokens in the normalized
 * CreationDate format are compared.
 */
export function startTokensComparable(expected: ProcessIdentity, current: ProcessSnapshot): boolean {
  if (!expected.startToken || !current.startToken) return false;
  if (!expected.startTokenSource || expected.startTokenSource !== current.startTokenSource) return false;
  if (expected.startTokenSource === 'powershell') {
    return isNormalizedCreationDate(expected.startToken) && isNormalizedCreationDate(current.startToken);
  }
  return true;
}

export function identityMatches(expected: ProcessIdentity, current: ProcessSnapshot, platform: HostPlatform): boolean {
  if (expected.pid !== current.pid) return false;
  if (expected.imageName && current.imageName && !imageNamesMatch(expected.imageName, current.imageName, platform)) {
    return false;
  }
  if (startTokensComparable(expected, current) && expected.startToken !== current.startToken) return false;
  return true;
}

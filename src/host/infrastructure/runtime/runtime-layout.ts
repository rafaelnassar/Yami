/**
 * On-disk layout of managed tools under `HostPaths.runtimeDir`:
 *
 *   bin/<tool>[.exe]        managed executables (+ ffprobe)
 *   bin/.<tool>.json        installed version, sha256, source URL
 *   python/                 managed Python (python-build-standalone)
 *   .tmp/                   downloads and extraction scratch (cleaned at startup)
 */
import path from 'node:path';
import type { HostPlatform } from '../../application/ports/engines.ts';

export interface RuntimeLayout {
  readonly platform: HostPlatform;
  readonly root: string;
  readonly binDir: string;
  readonly pythonDir: string;
  readonly tmpDir: string;
  /** Python executable of the managed distribution. */
  readonly pythonExecutable: string;
  exeName(name: string): string;
  binPath(name: string): string;
  metaPath(tool: string): string;
  pathApi(): typeof path;
}

export function runtimeLayout(runtimeDir: string, platform: HostPlatform): RuntimeLayout {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const binDir = api.join(runtimeDir, 'bin');
  const pythonDir = api.join(runtimeDir, 'python');
  const exeName = (name: string): string => (platform === 'win32' ? `${name}.exe` : name);
  return {
    platform,
    root: runtimeDir,
    binDir,
    pythonDir,
    tmpDir: api.join(runtimeDir, '.tmp'),
    pythonExecutable: platform === 'win32' ? api.join(pythonDir, 'python.exe') : api.join(pythonDir, 'bin', 'python3'),
    exeName,
    binPath: (name) => api.join(binDir, exeName(name)),
    metaPath: (tool) => api.join(binDir, `.${tool}.json`),
    pathApi: () => api
  };
}

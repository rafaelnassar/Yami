/**
 * Places verified artifacts into the managed layout.
 *
 * Replacement is atomic: the new file is moved next to the target (same
 * filesystem, `.tmp` lives inside the runtime dir) and renamed over it, so a crash
 * never leaves a half-written executable. On Windows a running executable cannot
 * be replaced — that surfaces as `TOOLS_INSTALL_FAILED` with a "file in use" detail
 * instead of the legacy stray `<dest>.<pid>.tmp` files.
 *
 * Python is staged, then swapped: `beforeSwap` runs on the extracted distribution
 * (python mode pip-installs the engines into it), and only a ready distribution is
 * renamed over the current one. python-build-standalone is relocatable and the app
 * runs the engines as `python -m <module>`, so the move is safe for them; pip's
 * console scripts (`bin/gallery-dl`, `Scripts\*.exe`) keep the staging path in
 * their shebang/launcher and are never used.
 */
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { delay } from '../../../shared/kernel/async.ts';
import { ErrorCode, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { TOOL_IDS, type ToolId } from '../../../shared/domain/engine.ts';
import { v } from '../../../shared/validation/schema.ts';
import type { Logger } from '../../application/ports/system.ts';
import type {
  InstalledToolMeta,
  InstallExecutableRequest,
  InstallPythonRequest,
  Staging,
  ToolInstaller
} from '../../application/runtime/ports.ts';
import type { RuntimeLayout } from './runtime-layout.ts';
import { isInside } from './path-containment.ts';

const MetaSchema = v.object({
  tool: v.enum(TOOL_IDS),
  version: v.string({ min: 1, max: 64 }),
  sha256: v.nullable(v.string({ pattern: /^[a-f0-9]{64}$/ })),
  source: v.string({ max: 4096 }),
  installedAt: v.number({ int: true, min: 0 })
});

const IN_USE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ETXTBSY']);

function errno(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : String(error);
}

/**
 * rename() that rides out short Windows locks (antivirus scanning a fresh
 * executable, a version probe still running it) before giving up.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !IN_USE_CODES.has(errno(error))) throw error;
      await delay(200 * attempt);
    }
  }
}

function suffix(): string {
  return randomBytes(4).toString('hex');
}

export class ManagedToolInstaller implements ToolInstaller {
  readonly #layout: RuntimeLayout;
  readonly #logger: Logger | null;

  constructor(layout: RuntimeLayout, logger: Logger | null = null) {
    this.#layout = layout;
    this.#logger = logger;
  }

  async prepare(): Promise<void> {
    const { binDir, tmpDir, root } = this.#layout;
    await mkdir(binDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    const stale = [
      ...(await readdir(tmpDir)).map((name) => this.#join(tmpDir, name)),
      ...(await readdir(binDir))
        .filter((n) => n.endsWith('.new') || n.endsWith('.tmp'))
        .map((n) => this.#join(binDir, n)),
      ...(await readdir(root)).filter((n) => n.startsWith('python.old-')).map((n) => this.#join(root, n))
    ];
    await Promise.all(stale.map((p) => rm(p, { recursive: true, force: true }).catch(() => undefined)));
  }

  async stage(tool: ToolId): Promise<Staging> {
    await mkdir(this.#layout.tmpDir, { recursive: true });
    const id = `${tool}-${suffix()}`;
    return {
      downloadPath: this.#join(this.#layout.tmpDir, `${id}.download`),
      extractDir: this.#join(this.#layout.tmpDir, `${id}-extract`)
    };
  }

  async release(staging: Staging): Promise<void> {
    await Promise.all([
      rm(staging.downloadPath, { force: true }).catch(() => undefined),
      rm(staging.extractDir, { recursive: true, force: true }).catch(() => undefined)
    ]);
  }

  async installExecutable(request: InstallExecutableRequest): Promise<Result<{ readonly path: string }, AppErrorData>> {
    const { tool, staging, entry } = request;
    const source = entry === null ? staging.downloadPath : this.#resolveEntry(staging.extractDir, entry);
    if (!source || !(await this.#isFile(source))) {
      return err({
        code: ErrorCode.TOOLS_INSTALL_FAILED,
        params: { tool, detail: `executable not found in package: ${entry ?? tool}` }
      });
    }
    await mkdir(this.#layout.binDir, { recursive: true });
    const target = this.#layout.binPath(tool);
    const placed = await this.#place(tool, source, target);
    if (!placed.ok) return placed;
    for (const [name, companionEntry] of Object.entries(request.companions)) {
      const companion = this.#resolveEntry(staging.extractDir, companionEntry);
      if (!companion || !(await this.#isFile(companion))) {
        this.#logger?.warn('companion binary missing from package', { tool, companion: name });
        continue;
      }
      const result = await this.#place(tool, companion, this.#layout.binPath(name));
      if (!result.ok) return result;
    }
    await this.#writeMeta(request.meta);
    return ok({ path: target });
  }

  async installPython(request: InstallPythonRequest): Promise<Result<{ readonly executable: string }, AppErrorData>> {
    const [rootName, ...exeSegments] = request.entry.split('/');
    const distribution = rootName ? this.#resolveEntry(request.staging.extractDir, rootName) : null;
    const missing = (): Result<never, AppErrorData> =>
      err({ code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool: 'python', detail: 'python not found in package' } });
    if (!distribution || exeSegments.length === 0) return missing();
    const staged = this.#join(distribution, ...exeSegments);
    if (!(await this.#isFile(staged))) return missing();
    if (request.beforeSwap) {
      // The current distribution (and its packages) stays in place unless the new one is ready.
      const prepared = await request.beforeSwap(staged);
      if (!prepared.ok) return prepared;
    }

    const target = this.#layout.pythonDir;
    const backup = this.#join(this.#layout.root, `python.old-${suffix()}`);
    const hadPrevious = await lstat(target).then(
      () => true,
      () => false
    );
    try {
      if (hadPrevious) await renameWithRetry(target, backup);
    } catch (error) {
      return this.#inUse('python', target, error);
    }
    try {
      await renameWithRetry(distribution, target);
    } catch (error) {
      if (hadPrevious) await rename(backup, target).catch(() => undefined);
      return this.#inUse('python', target, error);
    }
    if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    await this.#writeMeta(request.meta);
    return ok({ executable: this.#join(target, ...exeSegments) });
  }

  async readMeta(tool: ToolId): Promise<InstalledToolMeta | null> {
    try {
      const parsed = MetaSchema.parse(JSON.parse(await readFile(this.#layout.metaPath(tool), 'utf8')));
      return parsed.ok && parsed.value.tool === tool ? parsed.value : null;
    } catch {
      return null;
    }
  }

  async #place(tool: ToolId, source: string, target: string): Promise<Result<void, AppErrorData>> {
    const temp = `${target}.${suffix()}.new`;
    try {
      await rename(source, temp).catch(async (error: unknown) => {
        if (errno(error) !== 'EXDEV') throw error;
        await copyFile(source, temp);
      });
      if (this.#layout.platform !== 'win32') await chmod(temp, 0o755);
      await renameWithRetry(temp, target);
      return ok();
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      return this.#inUse(tool, target, error);
    }
  }

  #inUse(tool: ToolId, target: string, error: unknown): Result<never, AppErrorData> {
    const code = errno(error);
    const name = this.#layout.pathApi().basename(target);
    const detail = IN_USE_CODES.has(code) ? `file in use: ${name} (${code})` : `${name}: ${code}`;
    this.#logger?.warn('managed tool replacement failed', { tool, target, code });
    return err({ code: ErrorCode.TOOLS_INSTALL_FAILED, params: { tool, detail } });
  }

  async #writeMeta(meta: InstalledToolMeta): Promise<void> {
    const file = this.#layout.metaPath(meta.tool);
    const temp = `${file}.${suffix()}.tmp`;
    await mkdir(this.#layout.binDir, { recursive: true });
    await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  }

  /** Joins an archive-relative POSIX path, refusing anything that leaves `root`. */
  #resolveEntry(root: string, entry: string): string | null {
    const segments = entry.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
    const resolved = this.#join(root, ...segments);
    return isInside(root, resolved, this.#layout.pathApi()) ? resolved : null;
  }

  async #isFile(file: string): Promise<boolean> {
    const stats = await lstat(file).catch(() => null);
    return stats !== null && stats.isFile();
  }

  #join(...parts: string[]): string {
    return this.#layout.pathApi().join(...parts);
  }
}

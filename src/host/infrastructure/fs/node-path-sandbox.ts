/**
 * `PathSandbox`: every renderer-supplied path is canonicalized (realpath of the
 * deepest existing ancestor) and must stay inside the download directory and
 * outside the app's protected directories. Case-insensitive on Windows.
 */
import type { HostPlatform } from '../../application/ports/engines.ts';
import type { PathSandbox } from '../../application/ports/files.ts';
import { type AppErrorData, ErrorCode, appError } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';
import { canonicalize, errorCodeOf, NodeSandboxFileSystem, type SandboxFileSystem } from './canonical-path.ts';
import {
  isAmbiguousWindowsPath,
  isDiskRoot,
  isFullyQualified,
  isInsideOrEqual,
  pathModuleFor,
  samePath,
  syntaxProblem,
  type PathModule
} from './path-rules.ts';

export type DownloadDirForbiddenReason = 'root' | 'system' | 'home' | 'protected' | 'relative' | 'shared';

export interface NodePathSandboxOptions {
  /** App data, runtime, resources, logs…: never downloadable, never a download dir (or its parent). */
  readonly protectedDirs: readonly string[];
  readonly platform: HostPlatform;
  readonly homeDir: string;
  /** Canonical download directory (validated by the caller). */
  readonly initialDownloadDir: string;
  /** Windows `%SystemRoot%` (defaults to the environment). */
  readonly systemRoot?: string;
  /** Replaces the built-in system directory list (tests). */
  readonly systemDirs?: readonly string[];
  readonly fs?: SandboxFileSystem;
  /** Effective uid of the host (POSIX; defaults to `process.geteuid()`), for the shared-dir rule. */
  readonly uid?: number | null;
}

/** "Others may write" permission bit. */
const WORLD_WRITABLE = 0o002;

const POSIX_SYSTEM_DIRS: Readonly<Record<'linux' | 'darwin', readonly string[]>> = {
  linux: [
    '/bin',
    '/sbin',
    '/usr',
    '/etc',
    '/var',
    '/boot',
    '/dev',
    '/proc',
    '/sys',
    '/lib',
    '/lib32',
    '/lib64',
    '/libx32',
    '/run',
    '/snap'
  ],
  darwin: [
    '/System',
    '/Library',
    '/bin',
    '/sbin',
    '/usr',
    '/etc',
    '/var',
    '/private',
    '/dev',
    '/cores',
    '/Applications'
  ]
};

function invalid(reason: string): AppErrorData {
  return appError(ErrorCode.PATH_INVALID, { reason });
}

function forbidden(reason: DownloadDirForbiddenReason): AppErrorData {
  return appError(ErrorCode.DOWNLOAD_DIR_FORBIDDEN, { reason });
}

export class NodePathSandbox implements PathSandbox {
  readonly #platform: HostPlatform;
  readonly #path: PathModule;
  readonly #fs: SandboxFileSystem;
  readonly #protectedDirs: readonly string[];
  readonly #homeDir: string;
  readonly #systemRoot: string | null;
  readonly #systemDirs: readonly string[] | null;
  readonly #uid: number | null;
  #downloadDir: string;

  constructor(options: NodePathSandboxOptions) {
    this.#platform = options.platform;
    this.#path = pathModuleFor(options.platform);
    this.#fs = options.fs ?? new NodeSandboxFileSystem();
    this.#protectedDirs = options.protectedDirs.filter(Boolean).map((dir) => this.#path.resolve(dir));
    this.#homeDir = this.#path.resolve(options.homeDir);
    this.#systemRoot =
      options.systemRoot ?? (options.platform === 'win32' ? (process.env['SystemRoot'] ?? null) : null);
    this.#systemDirs = options.systemDirs ?? null;
    this.#uid = options.platform === 'win32' ? null : (options.uid ?? process.geteuid?.() ?? null);
    this.#downloadDir = this.#path.resolve(options.initialDownloadDir);
  }

  get downloadDir(): string {
    return this.#downloadDir;
  }

  setDownloadDir(canonicalDir: string): void {
    this.#downloadDir = this.#path.resolve(canonicalDir);
  }

  async resolveInside(
    input: string,
    options: { readonly mustExist?: boolean } = {}
  ): Promise<Result<string, AppErrorData>> {
    if (typeof input !== 'string') return err(invalid('empty'));
    const problem = syntaxProblem(input, this.#platform);
    if (problem) return err(invalid(problem));
    if (isAmbiguousWindowsPath(input, this.#platform)) return err(invalid('ambiguous'));

    const root = this.#downloadDir;
    // Relative inputs are relative to the download dir (never to the host's cwd).
    const lexical = this.#path.resolve(root, input);
    const rootCanonical = await canonicalize(root, this.#path, this.#fs);
    const rootForms = rootCanonical.ok ? [root, rootCanonical.value.path] : [root];
    if (!rootForms.some((form) => isInsideOrEqual(form, lexical, this.#platform))) {
      return err(appError(ErrorCode.PATH_OUTSIDE_SANDBOX));
    }

    const canonical = await canonicalize(lexical, this.#path, this.#fs);
    if (!canonical.ok) return canonical;
    const { path: real, exists } = canonical.value;
    if (options.mustExist && !exists) return err(appError(ErrorCode.PATH_NOT_FOUND));
    // Symlinks/junctions inside the download dir must not lead outside it.
    if (!rootCanonical.ok || !isInsideOrEqual(rootCanonical.value.path, real, this.#platform)) {
      return err(appError(ErrorCode.PATH_OUTSIDE_SANDBOX));
    }
    const protectedForms = await this.#protectedForms();
    if (protectedForms.some((dir) => isInsideOrEqual(dir, real, this.#platform))) {
      return err(appError(ErrorCode.PATH_OUTSIDE_SANDBOX, { reason: 'protected' }));
    }
    return ok(real);
  }

  async validateDownloadDir(input: string): Promise<Result<string, AppErrorData>> {
    if (typeof input !== 'string') return err(invalid('empty'));
    const trimmed = input.trim();
    const problem = syntaxProblem(trimmed, this.#platform);
    if (problem) return err(invalid(problem));
    if (!isFullyQualified(trimmed, this.#platform)) return err(forbidden('relative'));

    const lexical = this.#path.resolve(trimmed);
    const canonical = await canonicalize(lexical, this.#path, this.#fs);
    if (!canonical.ok) return canonical;
    const before =
      (await this.#forbiddenReason([lexical, canonical.value.path])) ??
      (await this.#sharedReason(canonical.value.path));
    if (before) return err(forbidden(before));

    try {
      await this.#fs.mkdirp(canonical.value.path);
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === 'EEXIST' || code === 'ENOTDIR') return err(invalid('not-a-directory'));
      return err(appError(ErrorCode.FILE_OPERATION_FAILED, { detail: code ?? 'mkdir' }));
    }
    let final: string;
    try {
      final = await this.#fs.realpath(canonical.value.path);
    } catch (error) {
      return err(invalid(errorCodeOf(error) ?? 'unresolvable'));
    }
    // Re-check the created directory: a component may have been swapped for a link meanwhile.
    const after = (await this.#forbiddenReason([final])) ?? (await this.#sharedReason(final));
    return after ? err(forbidden(after)) : ok(final);
  }

  /**
   * POSIX: a download dir that is (or sits under) a world-writable directory owned
   * by someone else — `/tmp`, `/var/tmp`, `/Users/Shared`, a 0777 mount — is
   * rejected, sticky bit or not: another local user can pre-create or re-create the
   * folder (e.g. after `/tmp` is wiped at reboot), read what Yami saves there or
   * plant links. Only canonical paths are walked, so the ancestors are real dirs.
   *
   * Windows: mode bits do not exist; who may write is decided by ACLs (a new folder
   * under `C:\` inherits "Authenticated Users: Modify", so it is shared too).
   * Evaluating effective ACLs needs Win32 security APIs that Node does not expose,
   * so this rule is not applied there (known gap); the root/system/home/protected
   * rules still are.
   */
  async #sharedReason(canonicalDir: string): Promise<DownloadDirForbiddenReason | null> {
    if (this.#platform === 'win32' || this.#uid === null) return null;
    let current = canonicalDir;
    for (;;) {
      const owner = await this.#fs.ownership(current);
      if (owner && (owner.mode & WORLD_WRITABLE) !== 0 && owner.uid !== this.#uid) return 'shared';
      const parent = this.#path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  async #forbiddenReason(forms: readonly string[]): Promise<DownloadDirForbiddenReason | null> {
    const platform = this.#platform;
    if (forms.some((form) => isDiskRoot(form, platform))) return 'root';

    const homeForms = await this.#withCanonical([this.#homeDir]);
    const isHome = forms.some((form) => homeForms.some((home) => samePath(home, form, platform)));
    const insideHome = forms.every((form) => homeForms.some((home) => isInsideOrEqual(home, form, platform)));
    // Paths inside the user's home are never system dirs (e.g. Fedora Silverblue homes live in /var/home).
    if (!insideHome) {
      const systemDirs = await this.#withCanonical(forms.flatMap((form) => this.#systemDirsFor(form)));
      if (forms.some((form) => systemDirs.some((dir) => isInsideOrEqual(dir, form, platform)))) return 'system';
    }
    if (isHome) return 'home';

    const protectedForms = await this.#protectedForms();
    const touchesProtected = forms.some((form) =>
      protectedForms.some((dir) => isInsideOrEqual(dir, form, platform) || isInsideOrEqual(form, dir, platform))
    );
    return touchesProtected ? 'protected' : null;
  }

  #systemDirsFor(candidate: string): string[] {
    if (this.#systemDirs) return [...this.#systemDirs];
    if (this.#platform !== 'win32') return [...POSIX_SYSTEM_DIRS[this.#platform]];
    const drive = this.#path.parse(this.#path.resolve(candidate)).root;
    const dirs = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'].map((name) =>
      this.#path.join(drive, name)
    );
    return this.#systemRoot ? [...dirs, this.#systemRoot] : dirs;
  }

  #protectedForms(): Promise<string[]> {
    return this.#withCanonical(this.#protectedDirs);
  }

  /** Each directory in lexical AND canonical form (either may be what a caller supplies). */
  async #withCanonical(dirs: readonly string[]): Promise<string[]> {
    const out = new Set<string>();
    for (const dir of dirs) {
      const lexical = this.#path.resolve(dir);
      out.add(lexical);
      const canonical = await canonicalize(lexical, this.#path, this.#fs);
      if (canonical.ok) out.add(canonical.value.path);
    }
    return [...out];
  }
}

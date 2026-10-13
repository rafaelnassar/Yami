/**
 * Hash locks of the python-mode pip packages, for scripts/update-runtime-manifest.mjs.
 *
 * For every platform that has a managed Python asset, pip (≥ 23.0) resolves the
 * pinned requirements of ALL engines together, in one run, as if they were
 * installed there:
 *
 *   python -m pip install --dry-run --ignore-installed --report <json> --only-binary=:all:
 *          --platform <tag> --python-version <X.Y> --implementation cp --target <tmp>
 *          "gallery-dl==<ver>" "yt-dlp[default]==<ver>"
 *
 * One resolution means one version per project, so the engines' locks can never
 * disagree on a shared dependency. The report (`install[].metadata` +
 * `download_info.archive_info.hashes`) is then split per engine: each
 * `pythonPackages.<engine>.lock.<platform>` = [{ name, version, sha256: [...] }] holds
 * the engine and every wheel reachable from it through `metadata.requires_dist`:
 * an edge guarded by `extra == "<x>"` only counts when that extra was requested
 * (`yt-dlp[default]`, `requests[socks]`), edges to projects pip did not install are
 * ignored and other markers are not evaluated (pip already did: an extra edge at
 * worst adds a wheel the engine does not need, a needed one is never missed). A
 * wheel no engine reaches makes the split fail loudly. The app
 * installs a lock with `--require-hashes --no-deps`; pip only offers wheels whose
 * digest is in it, so the wheel picked here for the platform's baseline tag is the
 * one installed.
 *
 * A platform where the pins cannot be resolved (no wheel for some dependency) can be
 * recorded as unsupported for python mode — `lock.<platform>: { unsupported: "<why>" }`
 * for every engine — with `--python-unsupported=<platform>`; `--verify` accepts it and
 * the packaged app refuses python mode there (standalone mode is unaffected).
 *
 * Limitation (pip): environment markers are evaluated against the interpreter that
 * runs the script, not the target. The dependency trees of gallery-dl and
 * yt-dlp[default] carry no OS markers; use a Python of the pinned X.Y for exact
 * `python_version` markers (a warning is printed otherwise).
 */

/**
 * pip `--platform` tag per manifest platform: the oldest baseline the managed Python
 * (python-build-standalone) runs on, so every selected wheel installs wherever the
 * app does. pip expands `manylinux2014` to the older manylinux tags and a macOS tag
 * to every older macOS version; Electron itself needs a newer macOS than 11.0.
 */
export const PIP_PLATFORM_TAGS = Object.freeze({
  'win32-x64': ['win_amd64'],
  'win32-arm64': ['win_arm64'],
  'win32-ia32': ['win32'],
  'darwin-x64': ['macosx_11_0_x86_64'],
  'darwin-arm64': ['macosx_11_0_arm64'],
  'linux-x64': ['manylinux2014_x86_64'],
  'linux-arm64': ['manylinux2014_aarch64']
});

export const MIN_PIP_VERSION = Object.freeze([23, 0]);

/** Longest `unsupported` reason kept in the manifest (the app schema allows 300). */
const MAX_UNSUPPORTED_REASON = 280;

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const DEPENDENCY_RE = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?/;
const MARKER_EXTRA_RE = /\bextra\s*==\s*["']([^"']+)["']/g;

/** PEP 503 normalized project name. */
export function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Numeric release segments without leading zeros (`2026.01.15` → `2026.1.15`), lower-case. */
export function normalizeVersion(version) {
  return version
    .toLowerCase()
    .split('.')
    .map((segment) => (/^\d+$/.test(segment) ? String(Number(segment)) : segment))
    .join('.');
}

/** `yt-dlp[default]` → `yt-dlp`. */
export function requirementName(requirement) {
  return requirement.replace(/\[.*$/, '');
}

/** Normalized extras of a requirement or dependency spec (`yt-dlp[default, Curl_CFFI]` → `default`, `curl-cffi`). */
function extrasOf(list) {
  return (list ?? '')
    .split(',')
    .map((extra) => extra.trim())
    .filter(Boolean)
    .map(normalizeName);
}

/** `3.12.14` → `3.12`. */
export function pythonSeries(version) {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(version ?? '');
  if (!match) throw new Error(`cannot derive the Python series from version ${JSON.stringify(version)}`);
  return `${match[1]}.${match[2]}`;
}

/** `<requirement>==<version>` of every engine pin, in manifest order. */
export function pinnedRequirements(pythonPackages) {
  return Object.values(pythonPackages).map((pin) => `${pin.requirement}==${pin.version}`);
}

/** Arguments after the interpreter (and its own prefix, e.g. `py -3`) for one joint resolution. */
export function pipReportArgs({ requirements, platform, pythonVersion, reportFile, targetDir }) {
  const tags = PIP_PLATFORM_TAGS[platform];
  if (!tags) throw new Error(`no pip platform tag for ${platform}`);
  if (!Array.isArray(requirements) || requirements.length === 0) throw new Error('no requirements to resolve');
  return [
    '-m',
    'pip',
    'install',
    '--dry-run',
    '--ignore-installed',
    // Ignore the developer's pip config / PIP_* variables: locks must reflect PyPI, like the app's `--isolated` install.
    '--isolated',
    '--disable-pip-version-check',
    '--no-input',
    '--quiet',
    '--report',
    reportFile,
    '--only-binary=:all:',
    ...tags.flatMap((tag) => ['--platform', tag]),
    '--python-version',
    pythonVersion,
    '--implementation',
    'cp',
    '--target',
    targetDir,
    ...requirements
  ];
}

function sha256Of(archiveInfo) {
  const direct = archiveInfo?.hashes?.sha256;
  if (typeof direct === 'string') return direct.toLowerCase();
  // Older reports only carry the legacy `hash` field (`sha256=<hex>`).
  const legacy = typeof archiveInfo?.hash === 'string' ? /^sha256=([A-Fa-f0-9]{64})$/.exec(archiveInfo.hash) : null;
  return legacy ? legacy[1].toLowerCase() : null;
}

/**
 * A `requires_dist` entry: `websockets (>=13); extra == "default"` →
 * `{ name: 'websockets', extras: [], whenExtras: ['default'] }` (`whenExtras` empty:
 * the edge does not depend on an extra). `null` when unreadable.
 */
export function parseDependency(spec) {
  const match = typeof spec === 'string' ? DEPENDENCY_RE.exec(spec) : null;
  if (!match) return null;
  const marker = spec.includes(';') ? spec.slice(spec.indexOf(';') + 1) : '';
  const whenExtras = [...marker.matchAll(MARKER_EXTRA_RE)].map((m) => normalizeName(m[1]));
  return { name: normalizeName(match[1]), extras: extrasOf(match[2]), whenExtras };
}

/** Normalized project name of a `requires_dist` entry, `null` when unreadable. */
export function dependencyName(spec) {
  return parseDependency(spec)?.name ?? null;
}

function wheelPathname(url) {
  try {
    return typeof url === 'string' && url.startsWith('https://') ? new URL(url).pathname : '';
  } catch {
    return '';
  }
}

/**
 * Validated entries of a pip installation report (format version 1, pip ≥ 23.0),
 * sorted by name: `{ name, version, sha256: [hex], requires: [parseDependency()] }`.
 * Throws when the report is not usable: every entry must be an https wheel with a SHA-256.
 */
export function readPipReport(report) {
  if (report === null || typeof report !== 'object') throw new Error('pip report: not a JSON object');
  if (report.version !== '1') {
    throw new Error(
      `pip report: unsupported format ${JSON.stringify(report.version)} (needs pip >= ${MIN_PIP_VERSION.join('.')})`
    );
  }
  if (!Array.isArray(report.install) || report.install.length === 0) throw new Error('pip report: nothing to install');
  const items = report.install.map((item) => {
    const name = item?.metadata?.name;
    const version = item?.metadata?.version;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`pip report: invalid package name ${JSON.stringify(name)}`);
    }
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      throw new Error(`pip report: invalid version ${JSON.stringify(version)} for ${name}`);
    }
    const pathname = wheelPathname(item?.download_info?.url);
    if (!pathname) throw new Error(`pip report: ${name} is not downloaded over https`);
    if (!pathname.endsWith('.whl')) {
      throw new Error(`pip report: ${name} is not a wheel (${pathname.slice(pathname.lastIndexOf('/') + 1)})`);
    }
    const sha256 = sha256Of(item.download_info.archive_info);
    if (sha256 === null || !SHA_RE.test(sha256)) throw new Error(`pip report: no SHA-256 for ${name}`);
    const requiresDist = Array.isArray(item.metadata.requires_dist) ? item.metadata.requires_dist : [];
    const requires = requiresDist.map(parseDependency).filter((dep) => dep !== null);
    return { name: normalizeName(name), version, sha256: [sha256], requires };
  });
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let index = 1; index < items.length; index += 1) {
    if (items[index].name === items[index - 1].name) throw new Error(`pip report: ${items[index].name} listed twice`);
  }
  return items;
}

/**
 * Splits one joint report into each engine's lock (see the header): `pins` is
 * `pythonPackages` (`{ <engine>: { requirement, version } }`). Throws when an
 * engine is not resolved at its pinned version or a wheel belongs to no engine.
 */
export function locksFromReport(report, pins) {
  const items = readPipReport(report);
  const byName = new Map(items.map((item) => [item.name, item]));
  const reached = new Set();
  const locks = {};
  for (const [engine, pin] of Object.entries(pins)) {
    const top = byName.get(normalizeName(requirementName(pin.requirement)));
    if (!top || normalizeVersion(top.version) !== normalizeVersion(pin.version)) {
      throw new Error(
        `pip report: ${requirementName(pin.requirement)}==${pin.version} was not resolved (got ${top ? top.version : 'nothing'})`
      );
    }
    const closure = reachableFrom(byName, top.name, extrasOf(/\[([^\]]*)\]/.exec(pin.requirement)?.[1]));
    for (const name of closure) reached.add(name);
    locks[engine] = items
      .filter((item) => closure.has(item.name))
      .map(({ name, version, sha256 }) => ({ name, version, sha256 }));
  }
  const orphan = items.find((item) => !reached.has(item.name));
  if (orphan) throw new Error(`pip report: ${orphan.name} is required by no engine (requires_dist incomplete?)`);
  return locks;
}

/** Names reachable from `start` (requested with `extras`), honouring `extra == "…"` guards. */
function reachableFrom(byName, start, extras) {
  const requested = new Map([[start, new Set(extras)]]);
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.shift();
    const active = requested.get(name);
    for (const dependency of byName.get(name)?.requires ?? []) {
      if (dependency.whenExtras.length > 0 && !dependency.whenExtras.some((extra) => active.has(extra))) continue;
      if (!byName.has(dependency.name)) continue;
      const seen = requested.get(dependency.name);
      const missing = dependency.extras.filter((extra) => !seen?.has(extra));
      if (seen && missing.length === 0) continue;
      requested.set(dependency.name, new Set([...(seen ?? []), ...dependency.extras]));
      queue.push(dependency.name); // revisited when new extras turn on more edges
    }
  }
  return new Set(requested.keys());
}

/** Python platforms (manifest keys of the managed Python asset) that need a lock. */
export function lockPlatforms(manifest) {
  return Object.keys(manifest?.tools?.python?.assets ?? {});
}

/** Whether a lock entry marks python mode unsupported on its platform. */
export function isUnsupportedLock(lock) {
  return lock !== null && typeof lock === 'object' && !Array.isArray(lock) && typeof lock.unsupported === 'string';
}

/** `{ unsupported }` entry with a reason that fits the app schema (single line, bounded). */
export function unsupportedLock(reason) {
  const text = String(reason).replace(/\s+/g, ' ').trim() || 'not resolvable';
  return { unsupported: text.slice(0, MAX_UNSUPPORTED_REASON) };
}

/** Whether `lock` (a wheel list) pins the package of `pin` at its version. */
export function lockMatchesPin(lock, pin) {
  if (!Array.isArray(lock) || lock.length === 0) return false;
  const name = normalizeName(requirementName(pin.requirement));
  const top = lock.find((wheel) => normalizeName(wheel.name) === name);
  return top !== undefined && normalizeVersion(top.version) === normalizeVersion(pin.version);
}

/**
 * Missing or stale locks, platforms marked unsupported for only some engines, and
 * dependencies the engines of one platform lock at different versions. A platform
 * marked unsupported for every engine is not a problem.
 */
export function lockProblems(manifest) {
  const problems = [];
  const packages = Object.entries(manifest?.pythonPackages ?? {});
  for (const platform of lockPlatforms(manifest)) {
    const unsupported = packages.filter(([, pin]) => isUnsupportedLock(pin.lock?.[platform]));
    const partly = unsupported.length > 0 && unsupported.length < packages.length;
    const versions = new Map();
    for (const [engine, pin] of packages) {
      const lock = pin.lock?.[platform];
      if (isUnsupportedLock(lock)) continue;
      if (partly) problems.push({ engine, platform, reason: 'python mode marked unsupported for other engines only' });
      else if (lock === undefined) problems.push({ engine, platform, reason: 'no hash lock' });
      else if (!lockMatchesPin(lock, pin))
        problems.push({ engine, platform, reason: `stale hash lock (pinned ${pin.version})` });
      for (const wheel of Array.isArray(lock) ? lock : []) {
        const name = normalizeName(wheel.name);
        const seen = versions.get(name);
        if (seen && normalizeVersion(seen.version) !== normalizeVersion(wheel.version)) {
          const reason = `${name} locked at ${seen.version} (${seen.engine}) and ${wheel.version} (${engine})`;
          problems.push({ engine, platform, reason });
        } else if (!seen) {
          versions.set(name, { version: wheel.version, engine });
        }
      }
    }
  }
  return problems;
}

/** Platforms with any lock problem (they are relocked as a whole). */
export function platformsNeedingLocks(manifest) {
  return [...new Set(lockProblems(manifest).map((problem) => problem.platform))];
}

/** Platforms every engine marks unsupported for python mode, with the first reason. */
export function unsupportedPlatforms(manifest) {
  const packages = Object.values(manifest?.pythonPackages ?? {});
  const out = [];
  for (const platform of lockPlatforms(manifest)) {
    const locks = packages.map((pin) => pin.lock?.[platform]);
    if (locks.length > 0 && locks.every(isUnsupportedLock)) out.push({ platform, reason: locks[0].unsupported });
  }
  return out;
}

/** Writes one platform's entry (`locks[engine]` or an unsupported marker) into every engine pin. */
export function setPlatformLocks(manifest, platform, locks) {
  for (const [engine, pin] of Object.entries(manifest.pythonPackages)) {
    const entry = locks[engine];
    if (entry === undefined) throw new Error(`no lock for ${engine} on ${platform}`);
    pin.lock = { ...pin.lock, [platform]: entry };
  }
}

/**
 * Removes every lock entry of the platforms the app would reject (stale after a
 * bump, conflicting, partly unsupported): a missing lock is valid for the app, an
 * invalid one makes the manifest fail to load. Returns one message per platform.
 */
export function pruneInvalidLocks(manifest) {
  const messages = [];
  for (const platform of platformsNeedingLocks(manifest)) {
    const reasons = lockProblems(manifest)
      .filter((problem) => problem.platform === platform && problem.reason !== 'no hash lock')
      .map((problem) => `${problem.engine}: ${problem.reason}`);
    if (reasons.length === 0) continue;
    for (const pin of Object.values(manifest.pythonPackages)) {
      if (!pin.lock) continue;
      delete pin.lock[platform];
      if (Object.keys(pin.lock).length === 0) delete pin.lock;
    }
    messages.push(`${platform} lock: ${reasons.join('; ')} — removed (not regenerated)`);
  }
  return messages;
}

/** Interpreters to try, in order: `$PYTHON`, `py -3` (Windows), `python3`, `python`. */
export function pythonCandidates(env, platform) {
  const candidates = [];
  if (env.PYTHON) candidates.push({ command: env.PYTHON, args: [] });
  if (platform === 'win32') candidates.push({ command: 'py', args: ['-3'] });
  candidates.push({ command: 'python3', args: [] }, { command: 'python', args: [] });
  return candidates;
}

/** `pip 24.0 from /x/pip (python 3.12)` → `{ pip: [24, 0], python: '3.12' }`, `null` when unrecognized. */
export function parsePipVersion(output) {
  const match = /^pip (\d+)\.(\d+)\S* from .*\(python (\d+\.\d+)\)\s*$/m.exec(output ?? '');
  return match ? { pip: [Number(match[1]), Number(match[2])], python: match[3] } : null;
}

function pipIsRecentEnough(pip) {
  const [major, minor] = MIN_PIP_VERSION;
  return pip[0] > major || (pip[0] === major && pip[1] >= minor);
}

/**
 * First usable interpreter (`-m pip --version` works and pip ≥ 23.0).
 * `run(command, args)` resolves to `{ ok, stdout }`. Returns `{ python, tried }`;
 * `python` is `null` when none qualifies (`tried` says why for each candidate).
 */
export async function findPython(env, platform, run) {
  const tried = [];
  for (const candidate of pythonCandidates(env, platform)) {
    const label = [candidate.command, ...candidate.args].join(' ');
    const result = await run(candidate.command, [...candidate.args, '-m', 'pip', '--version']);
    const version = result.ok ? parsePipVersion(result.stdout) : null;
    if (!result.ok || version === null) {
      tried.push(`${label}: ${result.ok ? 'unrecognized `pip --version` output' : 'not found or pip missing'}`);
      continue;
    }
    if (!pipIsRecentEnough(version.pip)) {
      tried.push(`${label}: pip ${version.pip.join('.')} is older than ${MIN_PIP_VERSION.join('.')}`);
      continue;
    }
    return { python: { ...candidate, label, pythonSeries: version.python }, tried };
  }
  return { python: null, tried };
}

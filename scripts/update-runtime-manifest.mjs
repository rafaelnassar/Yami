#!/usr/bin/env node
/**
 * Pins the runtime tools downloaded by the app (gallery-dl, yt-dlp, Deno, ffmpeg,
 * Python): fills `sha256` and `size` of every asset in
 * src/host/infrastructure/runtime/runtime-manifest.json, and generates the hash
 * locks of the python-mode pip packages (`pythonPackages.<engine>.lock.<platform>`,
 * see scripts/lib/pip-lock.mjs). Runs on a developer machine with internet access.
 *
 *   node scripts/update-runtime-manifest.mjs             pin assets whose sha256 is null, lock missing/stale pip locks
 *   node scripts/update-runtime-manifest.mjs --latest    bump to the latest upstream releases, then pin
 *   node scripts/update-runtime-manifest.mjs --force     re-pin every asset and regenerate every pip lock
 *   node scripts/update-runtime-manifest.mjs --verify    offline check: exit 1 if any sha256 or pip lock is missing (`npm run dist`)
 *   Options: --tool=<id> (only one tool; gallery-dl/yt-dlp/python also select pip locks), --dry-run (do not write), --help
 *            --python-unsupported=<platform>[,…]  record python mode as unsupported on these platforms when their
 *            pins cannot be resolved there (no compatible wheel); the packaged app then refuses python mode there
 *   Env: GITHUB_TOKEN (optional; raises the GitHub API rate limit). Behind a proxy use NODE_USE_ENV_PROXY=1.
 *        PYTHON (optional): interpreter for the pip locks; otherwise `py -3` (Windows), `python3`, `python`.
 *        Needs pip >= 23.0; prefer the Python series of the managed Python (e.g. 3.12).
 *
 * Checksum sources, in order of preference: the publisher's checksum list
 * (SHA2-256SUMS, SHA256SUMS, *.sha256sum), GitHub's asset digest, and finally
 * downloading and hashing the file. When two sources exist they must agree.
 * pip locks come from one `pip install --dry-run --report` per platform with every engine's pin (PyPI digests);
 * all engines of a platform are always relocked together, so their shared dependencies never disagree.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  findPython,
  isUnsupportedLock,
  lockPlatforms,
  lockProblems,
  locksFromReport,
  pinnedRequirements,
  pipReportArgs,
  platformsNeedingLocks,
  pruneInvalidLocks,
  pythonSeries,
  setPlatformLocks,
  unsupportedLock,
  unsupportedPlatforms
} from './lib/pip-lock.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'src/host/infrastructure/runtime/runtime-manifest.json');
const UA = 'yami-runtime-pin (+https://github.com/rafaelnassar/Yami)';
const SHA_RE = /^[a-f0-9]{64}$/;

/** Upstream conventions per GitHub repository (repos are derived from asset URLs). */
const REPOS = {
  'yt-dlp/yt-dlp': { checksums: { list: 'SHA2-256SUMS' }, version: (tag) => tag },
  'gdl-org/builds': { version: (tag) => tag.replace(/^v/i, '') },
  'denoland/deno': { checksums: { suffix: '.sha256sum' }, version: (tag) => tag.replace(/^v/i, '') },
  'GyanD/codexffmpeg': { tagPattern: /^\d+\.\d+(\.\d+)?$/, version: (tag) => tag },
  'eugeneware/ffmpeg-static': { tagPattern: /^b\d+(\.\d+)*$/, version: (tag) => tag.replace(/^b/, '') },
  'astral-sh/python-build-standalone': { checksums: { list: 'SHA256SUMS' }, python: true }
};

/* ───────────── CLI ───────────── */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const onlyTool = args.find((a) => a.startsWith('--tool='))?.slice('--tool='.length) ?? null;
const color = process.stdout.isTTY ? (code, text) => `\u001b[${code}m${text}\u001b[0m` : (_code, text) => text;
const ok = (text) => color(32, text);
const bad = (text) => color(31, text);
const dim = (text) => color(2, text);

if (flag('help')) {
  console.log(
    readFileSync(new URL(import.meta.url), 'utf8')
      .split('*/')[0]
      .replace(/^#!.*\n\/\*\*\n?/, '')
      .replace(/^ \* ?/gm, '')
  );
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const failures = [];

function* assets() {
  for (const [tool, spec] of Object.entries(manifest.tools)) {
    if (onlyTool && tool !== onlyTool) continue;
    for (const [platform, asset] of Object.entries(spec.assets)) yield { tool, platform, asset };
  }
}

function parseGithubUrl(url) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/?#]+)$/.exec(url);
  if (!match) return null;
  return { repo: match[1], tag: decodeURIComponent(match[2]), fileName: decodeURIComponent(match[3]) };
}

function releaseUrl(repo, tag, fileName) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

/* ───────────── HTTP ───────────── */

async function request(url, accept) {
  const headers = { 'User-Agent': UA, Accept: accept };
  if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com/'))
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.url.startsWith('https://')) throw new Error(`insecure redirect to ${response.url}`);
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error('GitHub API rate limit reached — set GITHUB_TOKEN and retry');
  }
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} for ${url}`), { status: response.status });
  return response;
}

const apiCache = new Map();
function github(pathname) {
  if (!apiCache.has(pathname)) {
    apiCache.set(
      pathname,
      request(`https://api.github.com${pathname}`, 'application/vnd.github+json').then((r) => r.json())
    );
  }
  return apiCache.get(pathname);
}

async function releaseByTag(repo, tag) {
  try {
    return await github(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error.status === 404) throw new Error(`release ${repo}@${tag} not found (run with --latest to bump)`);
    throw error;
  }
}

async function latestRelease(repo) {
  const rule = REPOS[repo] ?? {};
  if (!rule.tagPattern) return github(`/repos/${repo}/releases/latest`);
  const list = await github(`/repos/${repo}/releases?per_page=50`);
  const release = list.find((r) => !r.draft && !r.prerelease && rule.tagPattern.test(r.tag_name));
  if (!release) throw new Error(`no release of ${repo} matches ${rule.tagPattern}`);
  return release;
}

const textCache = new Map();
function fetchText(url) {
  if (!textCache.has(url))
    textCache.set(
      url,
      request(url, 'text/plain, application/octet-stream').then((r) => r.text())
    );
  return textCache.get(url);
}

async function downloadAndHash(url, label) {
  const response = await request(url, 'application/octet-stream');
  const hash = createHash('sha256');
  let bytes = 0;
  let lastReport = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
    if (process.stdout.isTTY && Date.now() - lastReport > 500) {
      lastReport = Date.now();
      process.stdout.write(`\r    ${dim(`downloading ${label}… ${(bytes / 1048576).toFixed(1)} MB`)}   `);
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\r\u001b[2K');
  return { sha256: hash.digest('hex'), bytes };
}

/* ───────────── checksums ───────────── */

function fromList(text, fileName) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Fa-f0-9]{64})\s+\*?(?:\.\/)?(.+?)\s*$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1].toLowerCase();
  }
  return null;
}

/** Publisher checksum (list or per-asset file) for a GitHub release asset, or null. */
async function publishedChecksum(repo, release, fileName) {
  const rule = REPOS[repo]?.checksums;
  if (!rule) return null;
  const sumsName = rule.list ?? `${fileName}${rule.suffix}`;
  const sums = release.assets.find((a) => a.name === sumsName);
  if (!sums) return null;
  const text = await fetchText(sums.browser_download_url);
  // Per-asset files may be `sha256sum` output or PowerShell Get-FileHash tables: take the first digest.
  const sha = rule.list ? fromList(text, fileName) : (/\b([A-Fa-f0-9]{64})\b/.exec(text)?.[1]?.toLowerCase() ?? null);
  return sha ? { sha, source: sumsName } : null;
}

const pinned = new Map(); // url → { sha256, size, source } (several platforms share one file)

async function pinAsset(asset) {
  if (pinned.has(asset.url)) return pinned.get(asset.url);
  let sha = null;
  let size = null;
  const sources = [];
  const github = parseGithubUrl(asset.url);
  if (github) {
    const release = await releaseByTag(github.repo, github.tag);
    const found = release.assets.find((a) => a.name === github.fileName);
    if (!found)
      throw new Error(
        `asset ${github.fileName} not found in ${github.repo}@${github.tag} (run with --latest or fix the URL)`
      );
    size = found.size ?? null;
    const published = await publishedChecksum(github.repo, release, github.fileName);
    if (published) {
      sha = published.sha;
      sources.push(published.source);
    }
    const digest =
      typeof found.digest === 'string' && found.digest.startsWith('sha256:')
        ? found.digest.slice(7).toLowerCase()
        : null;
    if (digest) {
      if (sha && sha !== digest)
        throw new Error(`checksum mismatch: ${published.source} says ${sha}, GitHub digest says ${digest}`);
      sha = digest;
      sources.push('GitHub digest');
    }
  }
  if (!sha) {
    const downloaded = await downloadAndHash(asset.url, path.basename(new URL(asset.url).pathname));
    if (size !== null && downloaded.bytes !== size)
      throw new Error(`size mismatch: API says ${size}, downloaded ${downloaded.bytes}`);
    sha = downloaded.sha256;
    size = downloaded.bytes;
    sources.push('downloaded and hashed');
  }
  const result = { sha256: sha, size, source: sources.join(' + ') };
  pinned.set(asset.url, result);
  return result;
}

/* ───────────── bumping ───────────── */

function renameVersion(text, from, to) {
  return typeof text === 'string' && from ? text.split(from).join(to) : text;
}

async function bumpAsset(asset) {
  const github = parseGithubUrl(asset.url);
  if (!github) return 'not a GitHub release URL — left as is';
  const rule = REPOS[github.repo];
  if (!rule) return `no bump rule for ${github.repo} — left as is`;
  const latest = await latestRelease(github.repo);
  if (latest.tag_name === github.tag) return null;
  let fileName;
  let version;
  if (rule.python) {
    // cpython-3.12.14+20260814-<triple>-install_only_stripped.tar.gz → newest 3.12.x of the latest release
    const [, series, triple] = /^cpython-(\d+\.\d+)\.\d+\+[^-]+-(.+)$/.exec(github.fileName) ?? [];
    if (!series) throw new Error(`unexpected python asset name ${github.fileName}`);
    const pattern = new RegExp(
      `^cpython-(${series.replace('.', '\\.')}\\.\\d+)\\+${latest.tag_name}-${triple.replace(/[.+]/g, '\\$&')}$`
    );
    const candidates = latest.assets.map((a) => pattern.exec(a.name)).filter(Boolean);
    candidates.sort((a, b) => Number(b[1].split('.')[2]) - Number(a[1].split('.')[2]));
    if (!candidates[0]) throw new Error(`no ${series}.x build for ${triple} in ${github.repo}@${latest.tag_name}`);
    [fileName, version] = candidates[0];
  } else {
    version = rule.version(latest.tag_name);
    fileName = renameVersion(github.fileName, asset.version, version);
    if (!latest.assets.some((a) => a.name === fileName)) {
      throw new Error(`asset ${fileName} not found in ${github.repo}@${latest.tag_name} — update the manifest by hand`);
    }
  }
  const previous = asset.version;
  asset.url = releaseUrl(github.repo, latest.tag_name, fileName);
  if (asset.entry) asset.entry = renameVersion(asset.entry, previous, version);
  for (const name of Object.keys(asset.companions ?? {}))
    asset.companions[name] = renameVersion(asset.companions[name], previous, version);
  asset.version = version;
  asset.sha256 = null;
  asset.size = null;
  return `${previous} → ${version}`;
}

async function bumpPythonPackages() {
  if (onlyTool && onlyTool !== 'gallery-dl' && onlyTool !== 'yt-dlp') return;
  for (const [engine, pin] of Object.entries(manifest.pythonPackages)) {
    if (onlyTool && engine !== onlyTool) continue;
    const name = pin.requirement.replace(/\[.*$/, '');
    try {
      const info = await (await request(`https://pypi.org/pypi/${name}/json`, 'application/json')).json();
      const latest = info.info.version;
      // A bump makes this engine's locks stale: every platform is then relocked below (all engines together).
      if (latest !== pin.version) console.log(`  ${ok('↑')} pip ${pin.requirement} ${pin.version} → ${latest}`);
      pin.version = latest;
    } catch (error) {
      failures.push(`pip ${name}: ${error.message}`);
      console.log(`  ${bad('✗')} pip ${name}: ${error.message}`);
    }
  }
}

/* ───────────── python-mode pip locks ───────────── */

const execFileAsync = promisify(execFile);

async function runPython(command, commandArgs) {
  try {
    const options = { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000 };
    const { stdout } = await execFileAsync(command, commandArgs, options);
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr || error.message || '') };
  }
}

/** Whether the current `--tool` selects the pip locks (no filter, an engine or `python`). */
function locksSelected() {
  return !onlyTool || onlyTool === 'python' || Object.hasOwn(manifest.pythonPackages, onlyTool);
}

/** Platforms named by `--python-unsupported=` (validated against the manifest). */
function unsupportedFlagPlatforms() {
  const raw = args.find((a) => a.startsWith('--python-unsupported='))?.slice('--python-unsupported='.length) ?? '';
  const platforms = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const known = new Set(lockPlatforms(manifest));
  for (const platform of platforms.filter((p) => !known.has(p)))
    failures.push(`--python-unsupported: unknown platform ${platform}`);
  return new Set(platforms.filter((p) => known.has(p)));
}

function lastLine(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? 'no output').slice(0, 300);
}

function reportPruned() {
  for (const message of pruneInvalidLocks(manifest)) {
    failures.push(message);
    console.log(`  ${bad('✗')} ${message}`);
  }
}

/** Resolves every engine's pin for one platform in ONE pip run and returns each engine's lock. */
async function resolvePlatform(python, platform, scratch, index) {
  const pythonVersion = pythonSeries(manifest.tools.python.assets[platform]?.version);
  const reportFile = path.join(scratch, `report-${index}.json`);
  const targetDir = path.join(scratch, `target-${index}`);
  const requirements = pinnedRequirements(manifest.pythonPackages);
  const pipArgs = pipReportArgs({ requirements, platform, pythonVersion, reportFile, targetDir });
  const result = await runPython(python.command, [...python.args, ...pipArgs]);
  if (!result.ok) throw new Error(`pip failed: ${lastLine(result.stderr)}`);
  return locksFromReport(JSON.parse(readFileSync(reportFile, 'utf8')), manifest.pythonPackages);
}

async function pinPythonLocks() {
  if (!locksSelected()) return 0;
  console.log('\nLocking python-mode pip packages (hashes, all engines per platform)…');
  const markUnsupported = unsupportedFlagPlatforms();
  const targets = flag('force') ? lockPlatforms(manifest) : platformsNeedingLocks(manifest);
  for (const platform of markUnsupported) if (!targets.includes(platform)) targets.push(platform);
  if (targets.length === 0) {
    console.log(`  ${dim('·')} ${dim('every platform already locked')}`);
    return 0;
  }
  const { python, tried } = await findPython(process.env, process.platform, runPython);
  if (!python) {
    const message = `no Python with pip >= 23.0 found — set PYTHON=<path to python> (tried: ${tried.join('; ')})`;
    failures.push(`pip locks: ${message}`);
    console.log(`  ${bad('✗')} ${message}`);
    reportPruned();
    return 0;
  }
  console.log(`  ${dim(`using ${python.label} (Python ${python.pythonSeries})`)}`);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'yami-pip-lock-'));
  const warned = new Set();
  let count = 0;
  try {
    for (const [index, platform] of targets.entries()) {
      const label = platform.padEnd(12);
      const pythonVersion = manifest.tools.python.assets[platform]?.version ?? '';
      const series = /^\d+\.\d+/.exec(pythonVersion)?.[0] ?? pythonVersion;
      if (series !== python.pythonSeries && !warned.has(series)) {
        warned.add(series);
        const hint = `markers use Python ${python.pythonSeries}, the target is ${series}`;
        console.log(`  ${bad('!')} ${hint}: prefer PYTHON=<python ${series}>`);
      }
      const previous = Object.values(manifest.pythonPackages).map((pin) => pin.lock?.[platform]);
      const wasUnsupported = previous.length > 0 && previous.every(isUnsupportedLock);
      try {
        const locks = await resolvePlatform(python, platform, scratch, index);
        setPlatformLocks(manifest, platform, locks);
        count += 1;
        const sizes = Object.entries(locks).map(([engine, lock]) => `${engine} ${lock.length}`);
        console.log(`  ${ok('✓')} ${label} ${dim(`wheels: ${sizes.join(', ')}`)}`);
        if (markUnsupported.has(platform))
          console.log(`  ${dim('·')} ${label} ${dim('resolved: --python-unsupported ignored')}`);
      } catch (error) {
        if (wasUnsupported || markUnsupported.has(platform)) {
          // Keep the recorded reason when it was already unsupported (the new error may be transient).
          const marker = wasUnsupported ? previous[0] : unsupportedLock(error.message);
          setPlatformLocks(
            manifest,
            platform,
            Object.fromEntries(Object.keys(manifest.pythonPackages).map((e) => [e, marker]))
          );
          console.log(`  ${bad('!')} ${label} python mode unsupported: ${marker.unsupported}`);
          continue;
        }
        const hint = `(no compatible wheels? rerun with --python-unsupported=${platform})`;
        failures.push(`${platform} lock: ${error.message} ${hint}`);
        console.log(`  ${bad('✗')} ${label} ${error.message} ${dim(hint)}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  reportPruned();
  return count;
}

/* ───────────── main ───────────── */

function verify() {
  const missing = [...assets()].filter(({ asset }) => !SHA_RE.test(asset.sha256 ?? ''));
  const insecure = [...assets()].filter(({ asset }) => !asset.url.startsWith('https://'));
  const locks = locksSelected() ? lockProblems(manifest) : [];
  const unsupported = locksSelected() ? unsupportedPlatforms(manifest) : [];
  for (const { tool, platform } of missing) console.log(`  ${bad('✗')} ${tool} ${platform}: sha256 not pinned`);
  for (const { tool, platform } of insecure) console.log(`  ${bad('✗')} ${tool} ${platform}: URL is not https`);
  for (const { engine, platform, reason } of locks) console.log(`  ${bad('✗')} pip ${engine} ${platform}: ${reason}`);
  for (const { platform, reason } of unsupported)
    console.log(`  ${dim('·')} python mode unsupported on ${platform}: ${reason}`);
  const problems = missing.length + insecure.length + locks.length;
  if (problems > 0) {
    console.log(
      bad(`\n${problems} problem(s). Run \`npm run runtime:pin\` (internet + Python) and commit the manifest.`)
    );
    process.exit(1);
  }
  const lockCount = locksSelected() ? lockPlatforms(manifest).length - unsupported.length : 0;
  console.log(ok(`✓ ${[...assets()].length} runtime assets pinned with SHA-256, ${lockCount} platform(s) pip-locked.`));
}

async function main() {
  console.log(`Runtime manifest: ${path.relative(ROOT, MANIFEST)}`);
  if (flag('verify')) return verify();

  if (flag('latest')) {
    console.log('\nChecking upstream releases…');
    for (const { tool, platform, asset } of assets()) {
      try {
        const change = await bumpAsset(asset);
        if (change) console.log(`  ${ok('↑')} ${tool.padEnd(10)} ${platform.padEnd(12)} ${change}`);
        // A new Python may change the wheel tags (cp312 → cp313): relock that platform (unsupported markers stay).
        if (change && tool === 'python') {
          for (const pin of Object.values(manifest.pythonPackages)) {
            if (pin.lock && !isUnsupportedLock(pin.lock[platform])) delete pin.lock[platform];
          }
        }
      } catch (error) {
        failures.push(`${tool} ${platform}: ${error.message}`);
        console.log(`  ${bad('✗')} ${tool.padEnd(10)} ${platform.padEnd(12)} ${error.message}`);
      }
    }
    await bumpPythonPackages();
  }

  console.log('\nPinning SHA-256…');
  let count = 0;
  let lastTool = '';
  for (const { tool, platform, asset } of assets()) {
    if (tool !== lastTool) console.log(`${tool} ${dim(asset.version)}`);
    lastTool = tool;
    if (asset.sha256 && !flag('force')) {
      console.log(`  ${dim('·')} ${platform.padEnd(12)} ${dim(`already pinned ${asset.sha256.slice(0, 12)}…`)}`);
      continue;
    }
    try {
      const result = await pinAsset(asset);
      if (asset.sha256 && asset.sha256 !== result.sha256)
        console.log(`  ${bad('!')} ${platform}: sha256 changed (was ${asset.sha256.slice(0, 12)}…)`);
      asset.sha256 = result.sha256;
      asset.size = result.size;
      count += 1;
      console.log(
        `  ${ok('✓')} ${platform.padEnd(12)} ${result.sha256.slice(0, 16)}…  ${dim(`${result.size ?? '?'} bytes · ${result.source}`)}`
      );
    } catch (error) {
      failures.push(`${tool} ${platform}: ${error.message}`);
      console.log(`  ${bad('✗')} ${platform.padEnd(12)} ${error.message}`);
    }
  }

  const locked = await pinPythonLocks();

  if (!flag('dry-run')) writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  const outcome = flag('dry-run') ? ' (dry run, nothing written)' : ', manifest written';
  console.log(`\n${count} asset(s) pinned, ${locked} platform(s) pip-locked${outcome}.`);
  if (failures.length > 0) {
    console.log(bad(`${failures.length} failure(s):`));
    for (const failure of failures) console.log(bad(`  - ${failure}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(bad(`update-runtime-manifest: ${error.stack ?? error}`));
  process.exit(1);
});

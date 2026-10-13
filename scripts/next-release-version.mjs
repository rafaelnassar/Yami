#!/usr/bin/env node
/**
 * Picks the next semver for a continuous GitHub Release (electron-updater).
 *
 * On every push to `main`, the release workflow runs this script:
 * - If package.json is already strictly ahead of the latest GitHub Release, keep it
 *   (intentional major/minor/patch bump in the commit).
 * - Otherwise bump the patch of the latest release (or keep package.json when there
 *   is no release yet).
 *
 * The chosen version is written back to package.json in the runner workspace so
 * electron-builder publishes matching artifacts and `latest.yml` for electron-updater.
 * The bump is not committed; the next run re-reads GitHub Releases.
 *
 * Usage:
 *   node scripts/next-release-version.mjs
 *   node scripts/next-release-version.mjs --print-only
 *
 * Env:
 *   GITHUB_REPOSITORY  — owner/repo (required)
 *   GITHUB_TOKEN / GH_TOKEN — optional; unauthenticated works for public repos (rate-limited)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const printOnly = process.argv.includes('--print-only');

/**
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }}
 */
function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  if (!match) throw new Error(`Invalid semver: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 */
function cmp(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** @param {{ major: number, minor: number, patch: number }} v */
function format(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** @param {{ major: number, minor: number, patch: number }} v */
function bumpPatch(v) {
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

/**
 * @param {string} owner
 * @param {string} repo
 * @param {string} token
 */
async function latestReleaseVersion(owner, repo, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'yami-next-release-version',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub releases/latest failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = /** @type {{ tag_name?: string }} */ (await res.json());
  const tag = String(data.tag_name ?? '').replace(/^v/i, '');
  if (!tag) return null;
  return parseSemver(tag);
}

async function main() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const pkgVersion = parseSemver(pkg.version);

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) {
    throw new Error('GITHUB_REPOSITORY (owner/repo) is required to compute the next version');
  }
  const [owner, name] = repo.split('/');
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const latest = await latestReleaseVersion(owner, name, token);

  let next = pkgVersion;
  if (latest && cmp(pkgVersion, latest) <= 0) next = bumpPatch(latest);

  const version = format(next);
  if (!printOnly) {
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${version}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

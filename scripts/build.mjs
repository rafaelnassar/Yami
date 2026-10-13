#!/usr/bin/env node
/**
 * Bundles the Node-side processes with esbuild (entry table: docs/ARCHITECTURE.md / team brief):
 *
 *   main    src/main/bootstrap/index.ts  → dist-electron/main.cjs
 *   preload src/preload/index.ts         → dist-electron/preload.cjs  (sandboxed: only `electron` external)
 *   host    src/host/bootstrap/index.ts  → dist-electron/host.cjs     (JSON runtime manifest embedded)
 *
 * and copies resources/icons/* → dist-electron/icons/. The renderer is built by Vite (`npm run build:renderer`).
 *
 * Usage:
 *   node scripts/build.mjs [--mode=production|development] [--watch] [--allow-missing]
 *
 *   --mode           production (default; minified, no sourcemaps) or development (linked sourcemaps).
 *                    `--watch` defaults to development.
 *   --watch          Rebuild on change. When spawned with an IPC channel, each build is reported to the
 *                    parent as `{ type: 'yami:build', ... }` and `{ type: 'yami:ready', ok }`.
 *   --allow-missing  Skip bundles whose entry file does not exist yet (warning instead of failure).
 *
 * `scripts/dev.mjs` imports `watchBundles()` from this module instead of spawning it.
 */
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const OUT_DIR = path.join(ROOT, 'dist-electron');
const ICONS_SRC = path.join(ROOT, 'resources', 'icons');
const ICONS_OUT = path.join(OUT_DIR, 'icons');
const TSCONFIG = path.join(ROOT, 'tsconfig.node.json');
const MODES = new Set(['development', 'production']);

/**
 * @typedef {'main' | 'preload' | 'host'} BundleName
 * @typedef {object} Bundle
 * @property {BundleName} name
 * @property {string} entry    source entry, relative to the repo root
 * @property {string} outfile  output file, relative to the repo root
 * @property {boolean} sandboxed  sandboxed preload: no Node built-ins, no import.meta shims
 * @typedef {'development' | 'production'} Mode
 * @typedef {{ mode?: Mode, allowMissing?: boolean }} BuildOptions
 * @typedef {{ phase: 'start', bundle: BundleName }
 *   | { phase: 'end', bundle: BundleName, ok: boolean, initial: boolean, errors: number, warnings: number,
 *       durationMs: number }} BuildEvent
 */

/** @type {readonly Bundle[]} */
export const BUNDLES = Object.freeze([
  { name: 'main', entry: 'src/main/bootstrap/index.ts', outfile: 'dist-electron/main.cjs', sandboxed: false },
  { name: 'preload', entry: 'src/preload/index.ts', outfile: 'dist-electron/preload.cjs', sandboxed: true },
  { name: 'host', entry: 'src/host/bootstrap/index.ts', outfile: 'dist-electron/host.cjs', sandboxed: false }
]);

/** Expected failure (bad arguments, missing entries, failed bundle): printed without a stack trace. */
export class BuildError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------------------------------------------

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
/** @param {string} code @param {string} text */
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const log = {
  /** @param {string} message */
  info: (message) => console.log(`${paint('36', '[build]')} ${message}`),
  /** @param {string} message */
  ok: (message) => console.log(`${paint('32', '[build]')} ${message}`),
  /** @param {string} message */
  warn: (message) => console.warn(`${paint('33', '[build] warning:')} ${message}`),
  /** @param {string} message */
  error: (message) => console.error(`${paint('31', '[build] error:')} ${message}`)
};

/** @param {number} bytes */
const formatSize = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`);
/** @param {number} ms */
const formatMs = (ms) => `${Math.round(ms)} ms`;

// ---------------------------------------------------------------------------------------------------------------
// esbuild configuration
// ---------------------------------------------------------------------------------------------------------------

/**
 * Main and host are CJS bundles, where `import.meta` would be an empty object. Map the common properties to their
 * CJS equivalents so code (and dependencies) written as ESM keeps working after bundling.
 */
const IMPORT_META_DEFINES = {
  'import.meta.dirname': '__dirname',
  'import.meta.filename': '__filename',
  'import.meta.url': '__yamiImportMetaUrl'
};
// The directive must stay first: a banner statement ahead of esbuild's own "use strict" would demote it.
const IMPORT_META_BANNER = [
  '"use strict";',
  'const __yamiImportMetaUrl = require("node:url").pathToFileURL(__filename).href;'
].join('\n');

/**
 * The preload runs sandboxed: only `electron` (and a few polyfilled modules) can be required at runtime, so any
 * Node built-in must fail the build instead of being left as an external `require()` that throws on load.
 * @type {esbuild.Plugin}
 */
const sandboxGuardPlugin = {
  name: 'yami-sandbox-guard',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path === 'electron' || !isBuiltin(args.path)) return undefined;
      return {
        errors: [
          {
            text: `Node built-in "${args.path}" cannot be used in the sandboxed preload (only "electron" is available).`
          }
        ]
      };
    });
  }
};

/**
 * @param {Bundle} bundle
 * @param {Mode} mode
 * @param {esbuild.Plugin[]} extraPlugins
 * @returns {esbuild.BuildOptions & { metafile: true }}
 */
function esbuildOptions(bundle, mode, extraPlugins = []) {
  const production = mode === 'production';
  return {
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, bundle.entry)],
    outfile: path.join(ROOT, bundle.outfile),
    bundle: true,
    platform: 'node', // Node built-ins (incl. every `node:*` specifier) stay external automatically.
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
    loader: { '.json': 'json' }, // Embeds imported JSON (e.g. the pinned runtime manifest in the host).
    tsconfig: TSCONFIG,
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      ...(bundle.sandboxed ? {} : IMPORT_META_DEFINES)
    },
    ...(bundle.sandboxed ? {} : { banner: { js: IMPORT_META_BANNER } }),
    minify: production,
    keepNames: true, // Keeps class/function names in stack traces and `error.name` after minification.
    sourcemap: production ? false : 'linked',
    charset: 'utf8',
    metafile: true,
    logLevel: 'warning', // esbuild prints errors/warnings itself (with code frames).
    plugins: [...(bundle.sandboxed ? [sandboxGuardPlugin] : []), ...extraPlugins]
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------------------

/**
 * Bundles whose entry exists. Missing entries fail the build unless `allowMissing` (used while the rewrite is in
 * progress and by smoke tests).
 * @param {boolean} allowMissing
 * @returns {Bundle[]}
 */
export function selectBundles(allowMissing) {
  const missing = BUNDLES.filter((bundle) => !existsSync(path.join(ROOT, bundle.entry)));
  if (missing.length > 0 && !allowMissing) {
    const list = missing.map((bundle) => `  - ${bundle.name}: ${bundle.entry}`).join('\n');
    throw new BuildError(`entry file(s) not found:\n${list}\n(pass --allow-missing to skip them)`);
  }
  for (const bundle of missing) log.warn(`skipping ${bundle.name}: ${bundle.entry} not found (--allow-missing)`);
  return BUNDLES.filter((bundle) => !missing.includes(bundle));
}

/**
 * Empties dist-electron/ (stale bundles must never be packaged) and copies the icons.
 * @param {boolean} allowMissing
 */
export async function prepareOutput(allowMissing) {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  await copyIcons(allowMissing);
}

/** @param {boolean} allowMissing */
async function copyIcons(allowMissing) {
  if (!existsSync(ICONS_SRC)) {
    const message = `icon folder not found: ${path.relative(ROOT, ICONS_SRC)}`;
    if (!allowMissing) throw new BuildError(message);
    log.warn(message);
    return;
  }
  await mkdir(ICONS_OUT, { recursive: true });
  const entries = await readdir(ICONS_SRC, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  // copyFile is a byte-for-byte copy (safe for .ico/.png).
  await Promise.all(files.map((file) => copyFile(path.join(ICONS_SRC, file.name), path.join(ICONS_OUT, file.name))));
  log.info(`copied ${files.length} icon(s) → ${path.relative(ROOT, ICONS_OUT)}`);
}

/**
 * @param {esbuild.Metafile | undefined} metafile
 * @param {Bundle} bundle
 */
function outputSize(metafile, bundle) {
  const bytes = metafile?.outputs[bundle.outfile]?.bytes;
  return bytes === undefined ? '' : formatSize(bytes);
}

/**
 * One-shot build of every (present) bundle. Throws `BuildError` if any bundle fails.
 * @param {BuildOptions} [options]
 */
export async function buildBundles({ mode = 'production', allowMissing = false } = {}) {
  const bundles = selectBundles(allowMissing);
  await prepareOutput(allowMissing);
  const started = performance.now();
  const results = await Promise.allSettled(bundles.map((bundle) => esbuild.build(esbuildOptions(bundle, mode))));

  /** @type {string[]} */
  const failed = [];
  results.forEach((result, index) => {
    const bundle = /** @type {Bundle} */ (bundles[index]);
    if (result.status === 'fulfilled') {
      log.ok(`${bundle.name.padEnd(8)} ${bundle.outfile.padEnd(28)} ${outputSize(result.value.metafile, bundle)}`);
      return;
    }
    failed.push(bundle.name);
    // esbuild already printed BuildFailure diagnostics (logLevel 'warning'); print anything else.
    const reason = /** @type {unknown} */ (result.reason);
    if (!(reason instanceof Error && 'errors' in reason)) log.error(`${bundle.name}: ${String(reason)}`);
  });

  if (failed.length > 0) throw new BuildError(`bundle(s) failed: ${failed.join(', ')}`);
  log.ok(`${bundles.length} bundle(s) built in ${formatMs(performance.now() - started)} (${mode})`);
}

/**
 * Starts esbuild in watch mode for every (present) bundle.
 *
 * `onBuild` receives `{ phase: 'start' }` when a bundle starts (re)building and `{ phase: 'end', ok, initial, ... }`
 * when it finishes. `ready` resolves after every bundle finished its first build (`ok` = all succeeded).
 *
 * @param {BuildOptions & { onBuild?: (event: BuildEvent) => void }} [options]
 * @returns {Promise<{ bundles: BundleName[], ready: Promise<{ ok: boolean }>, dispose: () => Promise<void> }>}
 */
export async function watchBundles({ mode = 'development', allowMissing = false, onBuild } = {}) {
  const bundles = selectBundles(allowMissing);
  await prepareOutput(allowMissing);

  /** @param {BuildEvent} event */
  const emit = (event) => {
    try {
      onBuild?.(event);
    } catch (error) {
      log.error(`build listener failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  };

  const pending = new Set(bundles.map((bundle) => bundle.name));
  let initialOk = true;
  /** @type {(value: { ok: boolean }) => void} */
  let resolveReady = () => {};
  /** @type {Promise<{ ok: boolean }>} */
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  if (pending.size === 0) resolveReady({ ok: true });

  /** @param {Bundle} bundle @returns {esbuild.Plugin} */
  const notifier = (bundle) => {
    let startedAt = 0;
    let initial = true;
    return {
      name: 'yami-watch-notifier',
      setup(build) {
        build.onStart(() => {
          startedAt = performance.now();
          emit({ phase: 'start', bundle: bundle.name });
        });
        build.onEnd((result) => {
          const ok = result.errors.length === 0;
          const durationMs = performance.now() - startedAt;
          const size = outputSize(result.metafile, bundle);
          if (ok) log.ok(`${bundle.name.padEnd(8)} ${size.padEnd(9)} ${formatMs(durationMs)}`);
          else log.error(`${bundle.name}: build failed (${result.errors.length} error(s)); waiting for changes…`);
          emit({
            phase: 'end',
            bundle: bundle.name,
            ok,
            initial,
            errors: result.errors.length,
            warnings: result.warnings.length,
            durationMs
          });
          if (initial) {
            initial = false;
            initialOk &&= ok;
            pending.delete(bundle.name);
            if (pending.size === 0) resolveReady({ ok: initialOk });
          }
        });
      }
    };
  };

  const contexts = await Promise.all(
    bundles.map((bundle) => esbuild.context(esbuildOptions(bundle, mode, [notifier(bundle)])))
  );
  // watch() schedules the initial build itself; completion is reported through the notifier.
  await Promise.all(contexts.map((context) => context.watch()));
  log.info(`watching ${bundles.map((bundle) => bundle.name).join(', ') || '(nothing)'} (${mode})`);

  let disposed = false;
  return {
    bundles: bundles.map((bundle) => bundle.name),
    ready,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await Promise.all(contexts.map((context) => context.dispose()));
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

const USAGE = 'usage: node scripts/build.mjs [--mode=production|development] [--watch] [--allow-missing]';

/**
 * @param {readonly string[]} argv
 * @returns {{ mode: Mode, watch: boolean, allowMissing: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let mode;
  let watch = false;
  let allowMissing = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = /** @type {string} */ (argv[index]);
    if (arg === '--watch') watch = true;
    else if (arg === '--allow-missing') allowMissing = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('--mode=')) mode = arg.slice('--mode='.length);
    else if (arg === '--mode') {
      mode = argv[index + 1];
      index += 1;
    } else throw new BuildError(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (mode !== undefined && !MODES.has(mode)) throw new BuildError(`invalid --mode: ${String(mode)}\n${USAGE}`);
  const resolvedMode = /** @type {Mode} */ (mode ?? (watch ? 'development' : 'production'));
  return { mode: resolvedMode, watch, allowMissing, help };
}

/** @param {unknown} message */
function sendToParent(message) {
  if (typeof process.send === 'function' && process.connected) process.send(message);
}

/** @param {readonly string[]} argv */
async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.watch) {
    await buildBundles(args);
    return;
  }

  const watcher = await watchBundles({
    ...args,
    onBuild: (event) => sendToParent({ type: 'yami:build', ...event })
  });
  void watcher.ready.then(({ ok }) => sendToParent({ type: 'yami:ready', ok }));

  const stop = () => {
    void watcher.dispose().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('disconnect', stop); // Parent (IPC) went away: don't linger as an orphan watcher.
}

function isEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2)).catch((error) => {
    if (error instanceof BuildError) log.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
/**
 * Development loop (`npm run dev`):
 *
 *   1. Vite dev server for the renderer on http://localhost:5173 (HMR, no Electron restart needed).
 *   2. esbuild in watch mode for main / preload / host (imported from build.mjs, not spawned).
 *   3. Electron with YAMI_DEV_SERVER_URL, restarted whenever a main-side bundle rebuilds successfully.
 *
 * Ctrl+C (or closing the app) shuts everything down. Arguments are forwarded to Electron, e.g.
 * `npm run dev -- --inspect=9229` or `npm run dev -- --remote-debugging-port=9222`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { BuildError, ROOT, watchBundles } from './build.mjs';

const DEV_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_PORT}`;
const VITE_CONFIG = path.join(ROOT, 'vite.config.ts');
/** Bundles sharing `src/shared` rebuild a few hundred ms apart; wait for the burst to settle before restarting. */
const RESTART_DEBOUNCE_MS = 300;
/** Main gets this long to shut down gracefully (it asks the host to pause downloads) before SIGKILL. */
const STOP_TIMEOUT_MS = 10_000;

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
/** @param {string} message */
const info = (message) => console.log(`${useColor ? '\x1b[35m[dev]\x1b[0m' : '[dev]'} ${message}`);
/** @param {string} message */
const fail = (message) => console.error(`${useColor ? '\x1b[31m[dev] error:\x1b[0m' : '[dev] error:'} ${message}`);
/** @param {unknown} error */
const describe = (error) => (error instanceof Error ? error.message : String(error));

/** @returns {Promise<typeof import('vite').createServer>} */
async function loadVite() {
  try {
    return (await import('vite')).createServer;
  } catch (error) {
    throw new BuildError(`could not load Vite (${describe(error)}). Run \`npm ci\`.`);
  }
}

/** @returns {Promise<string>} */
async function resolveElectronBinary() {
  /** @type {unknown} */
  let binary;
  try {
    // From Node, the `electron` package's default export is the path of the binary (its typings describe the
    // in-app API instead). Imported lazily: a missing download must not hide Vite/esbuild errors.
    binary = (await import('electron')).default;
  } catch (error) {
    const hint = 'Run `npx install-electron` or `npm ci`.';
    throw new BuildError(`Electron binary unavailable (${describe(error)}). ${hint}`);
  }
  if (typeof binary !== 'string') throw new BuildError('unexpected export from the `electron` package.');
  return binary;
}

/**
 * Runs one Electron process at a time. `stop()`/`restart()` are serialized so overlapping rebuilds never launch
 * two instances or kill a freshly started one.
 */
class ElectronRunner {
  /** @type {string} */
  #binary;
  /** @type {readonly string[]} */
  #args;
  /** @type {(code: number) => void} */
  #onUnexpectedExit;
  /** @type {import('node:child_process').ChildProcess | null} */
  #child = null;
  /** @type {Promise<void>} */
  #exited = Promise.resolve();
  /** @type {Promise<void>} */
  #queue = Promise.resolve();
  #stopping = false;

  /**
   * @param {string} binary
   * @param {readonly string[]} args extra Electron arguments
   * @param {(code: number) => void} onUnexpectedExit Electron exited on its own (app quit or crash)
   */
  constructor(binary, args, onUnexpectedExit) {
    this.#binary = binary;
    this.#args = args;
    this.#onUnexpectedExit = onUnexpectedExit;
  }

  get running() {
    return this.#child !== null;
  }

  start() {
    return this.#enqueue(async () => this.#spawn());
  }

  stop() {
    return this.#enqueue(() => this.#terminate());
  }

  restart() {
    return this.#enqueue(async () => {
      info('main-side bundle rebuilt → restarting Electron');
      await this.#terminate();
      this.#spawn();
    });
  }

  /** @param {() => Promise<void>} task */
  #enqueue(task) {
    this.#queue = this.#queue.then(task, task);
    return this.#queue;
  }

  #spawn() {
    if (this.#child) return;
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ...process.env,
      NODE_ENV: 'development',
      YAMI_DEV_SERVER_URL: DEV_SERVER_URL,
      // Stack traces map back to src/**.ts through the linked sourcemaps (NODE_OPTIONS is ignored when packaged).
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--enable-source-maps'].filter(Boolean).join(' ')
    };
    delete env.ELECTRON_RUN_AS_NODE; // Would turn Electron into plain Node and skip the app entirely.

    const child = spawn(this.#binary, ['.', ...this.#args], { cwd: ROOT, env, stdio: 'inherit' });
    this.#child = child;
    this.#exited = new Promise((resolve) => {
      /** @param {number} code */
      const settle = (code) => {
        if (this.#child !== child) return resolve(); // 'error' and 'exit' can both fire.
        this.#child = null;
        resolve();
        if (!this.#stopping) this.#onUnexpectedExit(code);
      };
      child.once('error', (error) => {
        fail(`could not start Electron: ${error.message}`);
        settle(1);
      });
      child.once('exit', (code, signal) => settle(code ?? (signal ? 1 : 0)));
    });
    if (child.pid !== undefined) info(`Electron started (pid ${child.pid})`);
  }

  /** SIGTERM = graceful quit on macOS/Linux (TerminateProcess on Windows); SIGKILL if it hangs. */
  async #terminate() {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    const timer = setTimeout(() => {
      if (this.#child === child) child.kill('SIGKILL');
    }, STOP_TIMEOUT_MS);
    try {
      child.kill('SIGTERM');
      await this.#exited;
    } finally {
      clearTimeout(timer);
      this.#stopping = false;
    }
  }
}

async function main() {
  const electronArgs = process.argv.slice(2);
  process.env.NODE_ENV = 'development';

  /** @type {Array<() => Promise<void>>} */
  const cleanups = [];
  let shuttingDown = false;
  /** @type {ElectronRunner | null} */
  let electron = null;

  /** @param {number} code */
  const shutdown = async (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('shutting down…');
    try {
      await electron?.stop();
      for (const cleanup of cleanups.reverse()) await cleanup().catch((error) => fail(String(error)));
    } finally {
      process.exit(code);
    }
  };

  process.on('SIGINT', () => {
    // A second Ctrl+C while shutting down means "now".
    if (shuttingDown) process.exit(130);
    void shutdown(0);
  });
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGHUP', () => void shutdown(0));

  try {
    if (!existsSync(VITE_CONFIG)) throw new BuildError(`Vite config not found: ${path.relative(ROOT, VITE_CONFIG)}`);

    // 1. Renderer.
    const createServer = await loadVite();
    const vite = await createServer({
      configFile: VITE_CONFIG,
      mode: 'development',
      server: { port: DEV_PORT, strictPort: true }
    });
    cleanups.push(() => vite.close());
    await vite.listen();
    vite.printUrls();

    // 2. Main-side bundles. Track per-bundle health so Electron only (re)starts on a fully green build.
    /** @type {Map<string, boolean>} */
    const healthy = new Map();
    /** @type {Set<string>} */
    const building = new Set();
    let initialDone = false;
    let restartWanted = false;
    /** @type {NodeJS.Timeout | undefined} */
    let restartTimer;

    const allHealthy = () => [...healthy.values()].every(Boolean);
    const scheduleRestart = () => {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (shuttingDown || !initialDone || !electron) return;
        if (building.size > 0 || !restartWanted) return; // The last bundle to finish reschedules.
        restartWanted = false;
        if (!allHealthy()) return; // Keep the running instance until the errors are fixed.
        void (electron.running ? electron.restart() : electron.start());
      }, RESTART_DEBOUNCE_MS);
    };

    const watcher = await watchBundles({
      mode: 'development',
      onBuild: (event) => {
        if (event.phase === 'start') {
          building.add(event.bundle);
          return;
        }
        building.delete(event.bundle);
        healthy.set(event.bundle, event.ok);
        if (!event.initial) {
          restartWanted ||= event.ok;
          scheduleRestart();
        }
      }
    });
    cleanups.push(() => watcher.dispose());

    // 3. Electron.
    const { ok } = await watcher.ready;
    initialDone = true;
    electron = new ElectronRunner(await resolveElectronBinary(), electronArgs, (code) => {
      info(`Electron exited (code ${code})`);
      void shutdown(code);
    });
    if (ok) await electron.start();
    else fail('initial build failed; Electron will start after the next successful rebuild.');
  } catch (error) {
    if (error instanceof BuildError) fail(error.message);
    else console.error(error);
    await shutdown(1);
  }
}

void main();

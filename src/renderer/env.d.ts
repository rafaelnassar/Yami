/// <reference types="vite/client" />
import type { YamiApi } from '../shared/contracts/ipc.ts';

declare global {
  interface Window {
    /** Preload bridge (contextBridge). Absent only when the page is opened outside Electron. */
    readonly yami: YamiApi;
  }
}

export {};

// Emulates Electron's `process.parentPort` over Node's IPC channel so the real host
// entry point can be exercised end-to-end in tests (no Electron runtime needed).
import process from 'node:process';

const listeners = new Set();
process.on('message', (data) => {
  for (const listener of listeners) listener({ data });
});
Object.defineProperty(process, 'parentPort', {
  value: {
    on(event, listener) {
      if (event === 'message') listeners.add(listener);
      return this;
    },
    postMessage(message) {
      process.send?.(message);
    }
  }
});

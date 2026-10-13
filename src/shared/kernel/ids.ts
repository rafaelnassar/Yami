/** Identifier generation (works in Node, Electron and the browser). */

/** Random URL-safe id, e.g. `k3j9x2-4f8a1c0e9b7d`. Time-prefixed so ids sort roughly by creation. */
export function newId(prefix = ''): string {
  const time = Date.now().toString(36);
  const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}${time}-${random}`;
}

/**
 * The few DOM touches of the preload. The node tsconfig has no DOM lib, so globals are
 * reached through `Reflect` with runtime checks instead of ambient DOM types.
 */

/** `location.search` of the page being loaded (`?view=tray` for the quick panel). */
export function currentSearch(): string {
  const location: unknown = Reflect.get(globalThis, 'location');
  if (typeof location !== 'object' || location === null) return '';
  const search: unknown = Reflect.get(location, 'search');
  return typeof search === 'string' ? search : '';
}

/** True when the drag carries files (`dataTransfer.types` contains `Files`). */
function isFileDrag(event: object): boolean {
  const transfer: unknown = Reflect.get(event, 'dataTransfer');
  if (typeof transfer !== 'object' || transfer === null) return false;
  const types: unknown = Reflect.get(transfer, 'types');
  if (typeof types !== 'object' || types === null) return false;
  const length: unknown = Reflect.get(types, 'length');
  if (typeof length !== 'number') return false;
  for (let index = 0; index < length; index += 1) {
    if (Reflect.get(types, index) === 'Files') return true;
  }
  return false;
}

function preventFileDrop(event: unknown): void {
  if (typeof event !== 'object' || event === null || !isFileDrag(event)) return;
  const prevent: unknown = Reflect.get(event, 'preventDefault');
  if (typeof prevent === 'function') Reflect.apply(prevent, event, []);
}

/**
 * Files dropped on the window must never be opened/navigated to (defense in depth on top
 * of `navigateOnDragDrop: false` and the navigation policy). Text/link drops are left alone
 * so the renderer's inputs keep working; renderer drop zones still run first (bubbling).
 */
export function blockFileDrops(): void {
  const add: unknown = Reflect.get(globalThis, 'addEventListener');
  if (typeof add !== 'function') return;
  for (const type of ['dragover', 'drop']) Reflect.apply(add, globalThis, [type, preventFileDrop]);
}

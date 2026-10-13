/** DOM focus helpers used by dialogs, menus and the preview. */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'video[controls]',
  'audio[controls]'
].join(',');

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('hidden') && !element.closest('[inert]') && element.getClientRects().length > 0
  );
}

/** Initial focus: `[data-autofocus]`, else the first focusable, else the container itself. */
export function focusInitial(container: HTMLElement): void {
  const preferred = container.querySelector<HTMLElement>('[data-autofocus]');
  const target = preferred ?? focusableElements(container)[0] ?? container;
  target.focus({ preventScroll: true });
}

/**
 * Moves focus to the element that follows `anchor` in tab order, skipping
 * everything inside `exclude` (e.g. a portaled menu). Wraps within the open
 * modal (or the document) and falls back to `anchor`.
 */
export function focusAfter(anchor: HTMLElement, exclude: HTMLElement | null): void {
  const scope = anchor.closest<HTMLElement>('[aria-modal="true"]') ?? document.body;
  const order = focusableElements(scope).filter((element) => element.tabIndex >= 0 && !exclude?.contains(element));
  const index = order.indexOf(anchor);
  const next = index >= 0 && order.length > 1 ? order[(index + 1) % order.length] : undefined;
  (next ?? anchor).focus();
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

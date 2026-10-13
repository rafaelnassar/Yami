/**
 * Chromium permission lockdown for every session (default, `persist:pixiv-oauth`, and any
 * session created later). Everything is denied, except two harmless capabilities the app
 * itself needs when the request comes from the app origin: element fullscreen (video
 * player) and sanitized clipboard *writes* ("copy link"). Clipboard reads always go
 * through main (`clipboard:read-urls`).
 */
import type { Session } from 'electron';

const APP_ALLOWED = new Set<string>(['fullscreen', 'clipboard-sanitized-write']);

export function isPermissionAllowed(
  permission: string,
  requestingUrl: string,
  isAppUrl: (url: string) => boolean
): boolean {
  return APP_ALLOWED.has(permission) && requestingUrl.length > 0 && isAppUrl(requestingUrl);
}

export function lockDownSession(session: Session, isAppUrl: (url: string) => boolean): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl ?? '', isAppUrl));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, isAppUrl)
  );
  session.setDevicePermissionHandler(() => false);
}

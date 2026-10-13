/**
 * Sidebar folder (organizes conversations; unrelated to directories on disk).
 * Pure rules: name, color and position validation plus create/patch.
 */
import type { Folder } from '../../../shared/domain/folder.ts';
import { ErrorCode, appError, type AppErrorData } from '../../../shared/kernel/errors.ts';
import { err, ok, type Result } from '../../../shared/kernel/result.ts';

export type { Folder };

export const FOLDER_NAME_MAX_LENGTH = 80;
export const FOLDER_POSITION_MAX = 100_000;
/** First color of the legacy palette; used when an imported color is unusable. */
export const DEFAULT_FOLDER_COLOR = '#94A3B8';

const COLOR = /^#[0-9A-Fa-f]{6}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001F\u007F]/g;

export function validateFolderName(raw: string): Result<string, AppErrorData> {
  const name = raw.trim();
  if (name.length === 0 || name.length > FOLDER_NAME_MAX_LENGTH || CONTROL_CHAR.test(name)) {
    return err(appError(ErrorCode.FOLDER_NAME_INVALID));
  }
  return ok(name);
}

/** Colors are stored upper-case so equal colors compare equal. */
export function validateFolderColor(raw: string): Result<string, AppErrorData> {
  return COLOR.test(raw) ? ok(raw.toUpperCase()) : err(appError(ErrorCode.VALIDATION_FAILED, { path: 'color' }));
}

export function validateFolderPosition(raw: number): Result<number, AppErrorData> {
  return Number.isInteger(raw) && raw >= 0 && raw <= FOLDER_POSITION_MAX
    ? ok(raw)
    : err(appError(ErrorCode.VALIDATION_FAILED, { path: 'position' }));
}

export interface NewFolderInput {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly position: number;
  readonly createdAt: number;
  readonly collapsed?: boolean;
}

export function createFolder(input: NewFolderInput): Result<Folder, AppErrorData> {
  const name = validateFolderName(input.name);
  if (!name.ok) return name;
  const color = validateFolderColor(input.color);
  if (!color.ok) return color;
  const position = validateFolderPosition(input.position);
  if (!position.ok) return position;
  return ok({
    id: input.id,
    name: name.value,
    color: color.value,
    collapsed: input.collapsed ?? false,
    position: position.value,
    createdAt: input.createdAt
  });
}

export interface FolderPatch {
  readonly name?: string;
  readonly color?: string;
  readonly collapsed?: boolean;
  readonly position?: number;
}

export function applyFolderPatch(folder: Folder, patch: FolderPatch): Result<Folder, AppErrorData> {
  let next: Folder = folder;
  if (patch.name !== undefined) {
    const name = validateFolderName(patch.name);
    if (!name.ok) return name;
    next = { ...next, name: name.value };
  }
  if (patch.color !== undefined) {
    const color = validateFolderColor(patch.color);
    if (!color.ok) return color;
    next = { ...next, color: color.value };
  }
  if (patch.position !== undefined) {
    const position = validateFolderPosition(patch.position);
    if (!position.ok) return position;
    next = { ...next, position: position.value };
  }
  if (patch.collapsed !== undefined) next = { ...next, collapsed: patch.collapsed };
  return ok(next);
}

/**
 * Best-effort cleanup of a folder name coming from legacy localStorage: control
 * characters removed, whitespace collapsed, truncated to the limit. `null` when
 * nothing usable remains.
 */
export function sanitizeImportedFolderName(raw: string): string | null {
  const cleaned = raw
    .replace(CONTROL_CHARS_GLOBAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FOLDER_NAME_MAX_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function sanitizeImportedFolderColor(raw: string): string {
  const trimmed = raw.trim();
  return COLOR.test(trimmed) ? trimmed.toUpperCase() : DEFAULT_FOLDER_COLOR;
}

/**
 * Sidebar folder (organizes conversations; unrelated to directories on disk).
 * Shared shape used by domain rules and IPC DTOs.
 */
export interface Folder {
  readonly id: string;
  readonly name: string;
  /** `#RRGGBB` */
  readonly color: string;
  readonly collapsed: boolean;
  readonly position: number;
  readonly createdAt: number;
}

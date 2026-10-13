/** Display helpers for file-system paths (pure; accepts `/` and `\`). */
import { baseName, dirName } from '../../../shared/domain/media.ts';

export { baseName, dirName };

/** Name of the folder containing `filePath` (`C:\dl\site\a.jpg` → `site`). */
export function parentFolderName(filePath: string): string {
  return baseName(dirName(filePath));
}

/** Walks `levels` directories up from `filePath`, keeping its native separators. */
export function ancestorPath(filePath: string, levels: number): string {
  let current = filePath;
  for (let i = 0; i < levels; i += 1) current = dirName(current);
  return current;
}

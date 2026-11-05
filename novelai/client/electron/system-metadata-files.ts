import type { Dirent } from 'node:fs';

/**
 * Files an operating system's file manager leaves in any folder it shows: macOS Finder's `.DS_Store` and the
 * AppleDouble `._<name>` companions (written with exactly this case), and Windows Explorer's `Thumbs.db` and
 * `desktop.ini` (case-insensitive, like the Windows file system). The app's own stores skip them: they are neither
 * read, counted, changed nor deleted, and they never make a store unusable.
 */
export function isSystemMetadataName(name: string): boolean {
  if (name === '.DS_Store' || name.startsWith('._')) return true;
  const lower = name.toLowerCase();
  return lower === 'thumbs.db' || lower === 'desktop.ini';
}

/** A directory entry that is such a file: a regular file (not a link or folder) with one of those names. */
export function isSystemMetadataFile(entry: Pick<Dirent, 'name' | 'isFile' | 'isSymbolicLink'>): boolean {
  return isSystemMetadataName(entry.name) && entry.isFile() && !entry.isSymbolicLink();
}

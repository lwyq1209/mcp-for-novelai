import fs from 'node:fs';
import path from 'node:path';

/**
 * Settings that name a folder for user data (generated images, logs, backups). None of them may lie inside the
 * application's install directory: installing another version replaces that directory.
 */
export const PROTECTED_DIRECTORY_KEYS = ['outputDir', 'backupDir', 'logDir'] as const;

/** Resolve existing ancestors as well, so junction aliases and not-yet-created subfolders are checked. */
export function canonicalDataPath(input: string): string {
  if (!path.isAbsolute(input)) throw Object.assign(new Error('A save folder must be an absolute path.'), { code: 'invalid_argument', reason: 'settings.folder_relative' });
  let ancestor = path.resolve(input);
  const suffix: string[] = [];
  for (;;) {
    try { return path.resolve(fs.realpathSync.native(ancestor), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(path.basename(ancestor)); ancestor = parent;
    }
  }
}

export function isInstallationDataPath(directory: string, installDirectory: string): boolean {
  const inside = (root: string, target: string) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  };
  // Both lexical location and physical target matter: an in-install junction itself goes away with the install directory.
  return inside(path.resolve(installDirectory), path.resolve(directory))
    || inside(canonicalDataPath(installDirectory), canonicalDataPath(directory));
}

/** Refuse a save folder inside the install directory (or a relative one); an empty value is left to the caller. */
export function assertSafeDataDirectory(directory: string, installDirectory: string): void {
  if (directory.trim()) canonicalDataPath(directory);
  if (directory.trim() && isInstallationDataPath(directory, installDirectory)) {
    // The window shows it by reason in its language (step 4c1).
    throw Object.assign(new Error(`Choose a folder outside the app's install folder, for example your Pictures folder; installing a new version replaces the install folder.\n${directory}`), { code: 'invalid_argument', reason: 'settings.folder_in_install', params: { folder: directory } });
  }
}

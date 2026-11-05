import path from 'node:path';
import type { LibraryRepository } from './library/repository';
import type { LibraryTrash } from './library-trash';

let current: { repository: LibraryRepository; userDataRoot: string; libraryDirectory: string } | null = null;
let trash: LibraryTrash | null = null;

/** Installed once at startup, after the library opened (library-startup.ts). A library that cannot be opened stops the start; there is no fallback store. */
export function activateLibrary(repository: LibraryRepository, options: { userDataRoot: string; libraryDirectory: string }) {
  current = { repository, userDataRoot: path.resolve(options.userDataRoot), libraryDirectory: path.resolve(options.libraryDirectory) };
}
export function activeLibrary(userDataRoot?: string): LibraryRepository | undefined {
  return current && (!userDataRoot || path.resolve(userDataRoot) === current.userDataRoot) ? current.repository : undefined;
}
export function activeLibraryPaths() { return current && { userDataRoot: current.userDataRoot, libraryDirectory: current.libraryDirectory }; }
export function deactivateLibrary() { current = null; trash = null; }
/** Recently Deleted of the active library (library-trash.ts), installed by main.ts after its startup recovery. */
export function activateLibraryTrash(service: LibraryTrash) { trash = service; }
export function activeLibraryTrash(): LibraryTrash | undefined { return trash ?? undefined; }

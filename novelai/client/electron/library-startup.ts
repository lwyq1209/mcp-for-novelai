import path from 'node:path';
import { openLibraryRepository } from './library/repository';
import { buildHistoryTagIndex } from './library/history-tag-index';
import { activateLibrary } from './library-runtime';
import { recoverLibraryFileOperations } from './library-file-operations';

/**
 * Opens <data root>/library.sqlite, the one store of the library, before anything is served. Without one, a new empty
 * library (version 8) is created: the first writable open creates its tables and version in one transaction, so a
 * start interrupted while creating it leaves no tables behind and the next start simply creates it again. A library of
 * any other version (or a file that is not a library) is refused without changing it (repository.ts).
 */
export async function initializeAssetLibrary(options: { userDataRoot: string; libraryDirectory: string; useWorker?: boolean }) {
  const databasePath = path.join(options.userDataRoot, 'library.sqlite');
  // Created (or checked) before the history tag worker opens it read-only; the main connection opens after the worker.
  openLibraryRepository({ filePath: databasePath, userDataRoot: options.userDataRoot, libraryDirectory: options.libraryDirectory }).close();
  await buildHistoryTagIndex({ databasePath, libraryDirectory: options.libraryDirectory, userDataRoot: options.userDataRoot, useWorker: options.useWorker ?? true });
  const repository = openLibraryRepository({ filePath: databasePath, userDataRoot: options.userDataRoot, libraryDirectory: options.libraryDirectory });
  activateLibrary(repository, options);
  await recoverLibraryFileOperations(repository);
  return repository;
}

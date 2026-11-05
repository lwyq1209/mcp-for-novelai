import { parentPort, workerData } from 'node:worker_threads';
import { openLibraryRepository } from './repository';

// The startup worker of buildHistoryTagIndex (history-tag-index.ts): its one action builds the history tag index.
try {
  if (workerData?.action !== 'history-tags') throw Object.assign(new Error('Unknown library worker action.'), { code: 'library_index_failed' });
  const repo = openLibraryRepository({ filePath: workerData.databasePath, libraryDirectory: workerData.libraryDirectory, userDataRoot: workerData.userDataRoot });
  let result;
  try { result = repo.rebuildHistoryTags(); } finally { repo.close(); }
  parentPort?.postMessage({ ok: true, result });
} catch (error: any) {
  parentPort?.postMessage({ ok: false, error: { code: error.code ?? 'library_index_failed', message: error.message ?? 'History tag indexing failed.' } });
} finally { parentPort?.close(); }

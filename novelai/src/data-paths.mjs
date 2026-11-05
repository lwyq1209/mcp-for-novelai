/**
 * ESM view of the shared data-root module (client/shared/runtime/data-paths.cjs), which the
 * Electron client compiles into its own build. Both sides compute the same data root
 * (NOVELAI_DATA_DIR, else <appData>/mcp-for-novelai) and the same project root for inbox and
 * export folders (NOVELAI_PROJECT_ROOT, else <data root>/workspace).
 */
import dataPaths from '../client/shared/runtime/data-paths.cjs';

export const {
  APP_DATA_DIR_NAME, DATA_DIR_ENV, PROJECT_ROOT_ENV, PROJECT_FOLDERS, PROJECT_ROOT_SOURCES,
  appDataDirectory, resolveDataRoot, dataPathsFor, resolveDataPaths, resolveProjectRoot, projectDirectories,
} = dataPaths;
